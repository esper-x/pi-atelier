import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexUsageTracker, formatCodexWindowLabel } from "../src/codex-usage.js";
import type { CodexUsageState } from "../src/types.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

const model = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

function context(payload: Record<string, unknown>, oauth = true) {
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
	const ctx = {
		model,
		modelRegistry: {
			isUsingOAuth: vi.fn().mockReturnValue(oauth),
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({
				ok: true,
				headers: { Authorization: "Bearer codex-token", "X-Private": "do-not-forward" },
				baseUrl: model.baseUrl,
			}),
		},
	};
	return { ctx, fetch };
}

describe("Codex usage tracker", () => {
	it("publishes only windows returned by Codex and does not invent a missing 5h limit", async () => {
		const { ctx, fetch } = context({
			rate_limit: {
				secondary_window: {
					used_percent: 61,
					limit_window_seconds: 604_800,
					reset_at: 2_000_000_000,
				},
			},
		});
		const states: CodexUsageState[] = [];
		const tracker = createCodexUsageTracker({
			ctx: ctx as never,
			fetch,
			onChange: (state) => states.push(state),
		});

		await tracker.refresh();
		tracker.dispose();

		expect(states).toEqual([
			{ status: "loading" },
			{
				status: "ready",
				windows: [
					{
						position: "secondary",
						remainingPercent: 39,
						windowMinutes: 10_080,
						resetsAt: 2_000_000_000,
					},
				],
			},
		]);
		const ready = states[1];
		expect(ready?.status).toBe("ready");
		if (ready?.status !== "ready") throw new Error("Expected ready Codex usage");
		expect(formatCodexWindowLabel(ready.windows[0]!)).toBe("Weekly");
		expect(fetch).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/wham/usage",
			expect.objectContaining({ headers: { Authorization: "Bearer codex-token" } }),
		);
	});

	it("selects a model-specific bucket and labels unknown-duration windows without assuming 5h", async () => {
		const { ctx, fetch } = context({
			rate_limit: { secondary_window: { used_percent: 80, limit_window_seconds: 604_800 } },
			additional_rate_limits: [
				{
					metered_feature: "gpt-5.6-sol",
					rate_limit: { primary_window: { used_percent: "12" } },
				},
			],
		});
		const states: CodexUsageState[] = [];
		const tracker = createCodexUsageTracker({
			ctx: ctx as never,
			fetch,
			onChange: (state) => states.push(state),
		});

		await tracker.refresh();
		tracker.dispose();

		const ready = states.at(-1);
		expect(ready).toEqual({
			status: "ready",
			windows: [{ position: "primary", remainingPercent: 88 }],
		});
		if (ready?.status !== "ready") throw new Error("Expected ready Codex usage");
		expect(formatCodexWindowLabel(ready.windows[0]!)).toBe("Primary");
	});

	it("stays hidden without an active official Codex OAuth model", async () => {
		const { ctx, fetch } = context({}, false);
		const states: CodexUsageState[] = [];
		const tracker = createCodexUsageTracker({
			ctx: ctx as never,
			fetch,
			onChange: (state) => states.push(state),
		});

		await tracker.refresh();
		tracker.dispose();

		expect(states).toEqual([{ status: "hidden" }]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("fails closed when resolved auth points at a proxy", async () => {
		const { ctx, fetch } = context({});
		ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
			ok: true,
			headers: { Authorization: "Bearer codex-token" },
			baseUrl: "https://proxy.example.test/backend-api",
		});
		const states: CodexUsageState[] = [];
		const tracker = createCodexUsageTracker({
			ctx: ctx as never,
			fetch,
			onChange: (state) => states.push(state),
		});

		await tracker.refresh();
		tracker.dispose();

		expect(states).toEqual([{ status: "loading" }, { status: "unavailable" }]);
		expect(fetch).not.toHaveBeenCalled();
	});
});
