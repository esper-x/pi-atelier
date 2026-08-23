import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexLimitWindow, CodexUsageState } from "./types.js";

const CODEX_PROVIDER = "openai-codex";
const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_USAGE_URL = `${CODEX_ORIGIN}/backend-api/wham/usage`;
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

type CodexContext = Pick<ExtensionContext, "model" | "modelRegistry">;
type Fetch = typeof globalThis.fetch;

export interface CodexUsageTracker {
	refresh(): Promise<void>;
	dispose(): void;
}

export interface CodexUsageTrackerOptions {
	ctx: CodexContext;
	onChange(state: CodexUsageState): void;
	fetch?: Fetch;
	refreshIntervalMs?: number;
}

export function createCodexUsageTracker(options: CodexUsageTrackerOptions): CodexUsageTracker {
	const request = options.fetch ?? globalThis.fetch;
	const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
	let disposed = false;
	let generation = 0;
	let controller: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const schedule = (): void => {
		clearTimer();
		if (disposed) return;
		timer = setTimeout(() => void refresh(), refreshIntervalMs);
		timer.unref?.();
	};
	const refresh = async (): Promise<void> => {
		const model = options.ctx.model;
		const eligible =
			process.env.PI_OFFLINE === undefined &&
			model?.provider === CODEX_PROVIDER &&
			options.ctx.modelRegistry.isUsingOAuth(model) &&
			isOfficialOrigin(model.baseUrl);
		generation += 1;
		const currentGeneration = generation;
		controller?.abort();
		controller = undefined;
		clearTimer();
		if (!eligible || !model) {
			options.onChange({ status: "hidden" });
			return;
		}

		options.onChange({ status: "loading" });
		const activeController = new AbortController();
		controller = activeController;
		try {
			const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || (auth.baseUrl && !isOfficialOrigin(auth.baseUrl))) {
				throw new Error("Codex runtime authentication is unavailable.");
			}
			const authorization =
				headerValue(auth.headers, "Authorization") ?? (auth.apiKey ? `Bearer ${auth.apiKey}` : undefined);
			if (!authorization) throw new Error("Codex runtime authentication is unavailable.");
			const response = await request(CODEX_USAGE_URL, {
				headers: { Authorization: authorization },
				signal: AbortSignal.any([activeController.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
			});
			if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
			const payload = JSON.parse(await readBoundedBody(response)) as unknown;
			const windows = selectCodexWindows(payload, model.id, model.name);
			if (disposed || currentGeneration !== generation || activeController.signal.aborted) return;
			options.onChange(windows.length > 0 ? { status: "ready", windows } : { status: "unavailable" });
		} catch {
			if (disposed || currentGeneration !== generation || activeController.signal.aborted) return;
			options.onChange({ status: "unavailable" });
		} finally {
			if (controller === activeController) controller = undefined;
			if (!disposed && currentGeneration === generation) schedule();
		}
	};

	return {
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			generation += 1;
			controller?.abort();
			controller = undefined;
			clearTimer();
		},
	};
}

export function formatCodexWindowLabel(window: CodexLimitWindow, compact = false): string {
	const minutes = window.windowMinutes;
	if (!minutes) return window.position === "primary" ? "Primary" : "Secondary";
	if (minutes === 10_080) return compact ? "wk" : "Weekly";
	if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

export function formatCodexResetTime(epochSeconds: number): string | undefined {
	if (!Number.isFinite(epochSeconds)) return undefined;
	const reset = new Date(epochSeconds * 1_000);
	if (Number.isNaN(reset.getTime())) return undefined;
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset.getMinutes().toString().padStart(2, "0")}`;
	const now = new Date();
	if (reset.toDateString() === now.toDateString()) return time;
	return `${reset.getDate()} ${reset.toLocaleDateString("en", { month: "short" })} ${time}`;
}

function selectCodexWindows(payload: unknown, modelId: string, modelName: string): CodexLimitWindow[] {
	const root = asObject(payload);
	if (!root) return [];
	const groups = [{ id: "codex", rateLimit: root.rate_limit }];
	for (const raw of Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []) {
		const item = asObject(raw);
		const id = asString(item?.metered_feature) ?? asString(item?.limit_name);
		if (id) groups.push({ id, rateLimit: item?.rate_limit });
	}
	const modelKeys = new Set([normalizeKey(modelId), normalizeKey(modelName)].filter(Boolean));
	const selected =
		groups.slice(1).find((group) => {
			const key = normalizeKey(group.id);
			return [...modelKeys].some(
				(modelKey) => modelKey === key || modelKey.endsWith(`-${key}`) || key.endsWith(`-${modelKey}`),
			);
		}) ?? groups[0];
	const windows = parseWindows(selected?.rateLimit);
	return windows.length > 0 || selected === groups[0] ? windows : parseWindows(groups[0]?.rateLimit);
}

function parseWindows(raw: unknown): CodexLimitWindow[] {
	const rateLimit = asObject(raw);
	if (!rateLimit) return [];
	return [
		parseWindow("primary", rateLimit.primary_window),
		parseWindow("secondary", rateLimit.secondary_window),
	].filter((window): window is CodexLimitWindow => window !== undefined);
}

function parseWindow(position: CodexLimitWindow["position"], raw: unknown): CodexLimitWindow | undefined {
	const value = asObject(raw);
	const used = asNumber(value?.used_percent);
	if (used === undefined) return undefined;
	const seconds = asNumber(value?.limit_window_seconds);
	const resetsAt = asNumber(value?.reset_at);
	return {
		position,
		remainingPercent: 100 - Math.min(100, Math.max(0, used)),
		...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

async function readBoundedBody(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error("Codex usage response was too large.");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("Codex usage response was too large.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function isOfficialOrigin(value: string | undefined): boolean {
	try {
		return new URL(value ?? "").origin === CODEX_ORIGIN;
	} catch {
		return false;
	}
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
	return (
		Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? undefined
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function normalizeKey(value: string | undefined): string {
	return (
		value
			?.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") ?? ""
	);
}
