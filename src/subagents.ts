import { randomUUID } from "node:crypto";
import { sanitizeSidebarPanelText } from "./sidebar-panels.js";

/** Public pi-subagents event-bus RPC channels (protocol v1). */
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request" as const;
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready" as const;
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:" as const;

const SUBAGENT_ACTIVITY_EVENTS = [
	SUBAGENT_RPC_READY_EVENT,
	"subagent:async-started",
	"subagent:async-complete",
	"subagent:foreground-complete",
	"subagent:process-terminal",
	"subagent:child-status",
] as const;

const MAX_ENTRIES = 16;
const DEFAULT_REFRESH_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export interface SubagentActivityEntry {
	key: string;
	agent: string;
	role?: string;
	model?: string;
	effort?: string;
	startedAt: number;
	tokens: number;
	goal?: string;
}

export interface SubagentActivitySnapshot {
	available: boolean;
	totalActive: number;
	omitted: number;
	capacity: {
		used: number;
		limit: number;
	};
	entries: readonly SubagentActivityEntry[];
}

export const EMPTY_SUBAGENT_ACTIVITY: SubagentActivitySnapshot = {
	available: false,
	totalActive: 0,
	omitted: 0,
	capacity: { used: 0, limit: 0 },
	entries: [],
};

export interface SubagentEventTransport {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

export interface SubagentActivityTracker {
	getSnapshot(): SubagentActivitySnapshot;
	isActive(): boolean;
	refresh(): void;
	dispose(): void;
}

export interface SubagentActivityTrackerOptions {
	events: SubagentEventTransport;
	onChange?: () => void;
	refreshMs?: number;
	requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeSidebarPanelText(value) || undefined;
}

function parseTokens(value: unknown): number {
	if (!isRecord(value)) return 0;
	return count(value.total) ?? 0;
}

function parseEntry(value: unknown): SubagentActivityEntry | undefined {
	if (!isRecord(value)) return undefined;
	const key = text(value.key);
	const agent = text(value.agent);
	const startedAt = count(value.startedAt);
	if (!key || !agent || startedAt === undefined) return undefined;
	const role = text(value.role);
	const model = text(value.model);
	const effort = text(value.effort);
	const goal = text(value.goal);
	return {
		key,
		agent,
		...(role ? { role } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		startedAt,
		tokens: parseTokens(value.tokens),
		...(goal ? { goal } : {}),
	};
}

function parseFleet(value: unknown): SubagentActivitySnapshot | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return undefined;
	const totalActive = count(value.totalActive);
	const omitted = count(value.omitted);
	const capacity = isRecord(value.topLevelAsyncCapacity) ? value.topLevelAsyncCapacity : undefined;
	const used = count(capacity?.used);
	const limit = count(capacity?.limit);
	if (totalActive === undefined || omitted === undefined || used === undefined || limit === undefined)
		return undefined;
	return {
		available: true,
		totalActive,
		omitted,
		capacity: { used, limit },
		entries: value.entries
			.slice(0, MAX_ENTRIES)
			.map(parseEntry)
			.filter((entry): entry is SubagentActivityEntry => entry !== undefined),
	};
}

function snapshotEqual(left: SubagentActivitySnapshot, right: SubagentActivitySnapshot): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Read pi-subagents through its versioned public RPC seam. The tracker owns all
 * correlation listeners and polling, leaving Sidebar rendering synchronous.
 */
export function createSubagentActivityTracker(
	options: SubagentActivityTrackerOptions,
): SubagentActivityTracker {
	const refreshMs = Math.max(100, Math.trunc(options.refreshMs ?? DEFAULT_REFRESH_MS));
	const requestTimeoutMs = Math.max(100, Math.trunc(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
	let snapshot = EMPTY_SUBAGENT_ACTIVITY;
	let disposed = false;
	let requestInFlight = false;
	let refreshPending = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let requestTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeReply: (() => void) | undefined;
	const unsubscribes: Array<() => void> = [];

	const publish = (next: SubagentActivitySnapshot): void => {
		if (snapshotEqual(snapshot, next)) return;
		snapshot = next;
		try {
			options.onChange?.();
		} catch {
			// Rendering invalidation is best effort and must not break RPC handling.
		}
	};

	const clearRefreshTimer = (): void => {
		if (!refreshTimer) return;
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
	};

	const schedule = (delay = 0): void => {
		if (disposed || refreshTimer) return;
		refreshTimer = setTimeout(
			() => {
				refreshTimer = undefined;
				request();
			},
			Math.max(0, delay),
		);
		refreshTimer.unref?.();
	};

	const finishRequest = (): void => {
		if (requestTimer) clearTimeout(requestTimer);
		requestTimer = undefined;
		unsubscribeReply?.();
		unsubscribeReply = undefined;
		requestInFlight = false;
		if (disposed) return;
		if (refreshPending) {
			refreshPending = false;
			schedule();
		} else if (snapshot.totalActive > 0 || snapshot.capacity.used > 0) {
			schedule(refreshMs);
		}
	};

	function request(): void {
		if (disposed) return;
		if (requestInFlight) {
			refreshPending = true;
			return;
		}
		requestInFlight = true;
		const requestId = `atelier-${randomUUID()}`;
		const replyChannel = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
		try {
			const unsubscribe = options.events.on(replyChannel, (value) => {
				if (!isRecord(value) || value.version !== 1 || value.requestId !== requestId) return;
				if (value.success === true && isRecord(value.data)) {
					const next = parseFleet(value.data.fleet);
					if (next) publish(next);
				}
				finishRequest();
			});
			unsubscribeReply = typeof unsubscribe === "function" ? unsubscribe : undefined;
			requestTimer = setTimeout(finishRequest, requestTimeoutMs);
			requestTimer.unref?.();
			options.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
				version: 1,
				requestId,
				method: "status",
				params: {},
				source: { extension: "pi-atelier" },
			});
		} catch {
			finishRequest();
		}
	}

	for (const channel of SUBAGENT_ACTIVITY_EVENTS) {
		try {
			const unsubscribe = options.events.on(channel, () => schedule());
			if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
		} catch {
			// A missing or partially initialized companion extension is optional.
		}
	}
	schedule();

	return {
		getSnapshot: () => ({
			...snapshot,
			capacity: { ...snapshot.capacity },
			entries: snapshot.entries.map((entry) => ({ ...entry })),
		}),
		isActive: () => snapshot.totalActive > 0 || snapshot.capacity.used > 0,
		refresh: () => schedule(),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			clearRefreshTimer();
			if (requestTimer) clearTimeout(requestTimer);
			requestTimer = undefined;
			unsubscribeReply?.();
			unsubscribeReply = undefined;
			for (const unsubscribe of unsubscribes) {
				try {
					unsubscribe();
				} catch {
					// Lifecycle cleanup is best effort.
				}
			}
			unsubscribes.length = 0;
		},
	};
}
