import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSubagentActivityTracker,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
} from "../src/subagents.js";

function eventBus(reply?: (request: Record<string, unknown>) => unknown) {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(handler);
			listeners.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
			if (channel !== SUBAGENT_RPC_REQUEST_EVENT || !reply || typeof data !== "object" || !data) return;
			const request = data as Record<string, unknown>;
			const requestId = request.requestId;
			if (typeof requestId !== "string") return;
			events.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`, reply(request));
		},
	};
	return { events, emitted, listeners };
}

function fleetReply(request: Record<string, unknown>) {
	return {
		version: 1,
		requestId: request.requestId,
		success: true,
		data: {
			fleet: {
				version: 1,
				totalActive: 2,
				omitted: 1,
				topLevelAsyncCapacity: { used: 1, limit: 8 },
				entries: [
					{
						key: "fleet-1",
						agent: "custom-reviewer",
						role: "correctness",
						model: "openai-codex/gpt-5.6-sol",
						effort: "high",
						startedAt: 1_000,
						tokens: { input: 900, output: 300, total: 1_200 },
						goal: "Review the current diff",
					},
				],
			},
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("subagent activity tracker", () => {
	it("reads bounded custom-agent activity through the public RPC fleet DTO", async () => {
		vi.useFakeTimers();
		const bus = eventBus(fleetReply);
		const changed = vi.fn();
		const tracker = createSubagentActivityTracker({
			events: bus.events,
			onChange: changed,
			refreshMs: 60_000,
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(bus.emitted.find((event) => event.channel === SUBAGENT_RPC_REQUEST_EVENT)?.data).toMatchObject({
			version: 1,
			method: "status",
			params: {},
			source: { extension: "pi-atelier" },
		});
		expect(tracker.getSnapshot()).toEqual({
			available: true,
			totalActive: 2,
			omitted: 1,
			capacity: { used: 1, limit: 8 },
			entries: [
				{
					key: "fleet-1",
					agent: "custom-reviewer",
					role: "correctness",
					model: "openai-codex/gpt-5.6-sol",
					effort: "high",
					startedAt: 1_000,
					tokens: 1_200,
					goal: "Review the current diff",
				},
			],
		});
		expect(tracker.isActive()).toBe(true);
		expect(changed).toHaveBeenCalledOnce();
		tracker.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("supports either extension load order and ignores malformed status payloads", async () => {
		vi.useFakeTimers();
		let valid = false;
		const bus = eventBus((request) =>
			valid
				? {
						version: 1,
						requestId: request.requestId,
						success: true,
						data: {
							fleet: {
								version: 1,
								totalActive: 0,
								omitted: 0,
								topLevelAsyncCapacity: { used: 0, limit: 8 },
								entries: [],
							},
						},
					}
				: { version: 1, requestId: request.requestId, success: true, data: { fleet: { version: 2 } } },
		);
		const tracker = createSubagentActivityTracker({ events: bus.events });
		await vi.advanceTimersByTimeAsync(0);
		expect(tracker.getSnapshot().available).toBe(false);

		valid = true;
		bus.events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(tracker.getSnapshot()).toMatchObject({
			available: true,
			totalActive: 0,
			capacity: { used: 0, limit: 8 },
		});
		tracker.dispose();
	});

	it("cleans up correlation and lifecycle listeners when disposed", async () => {
		vi.useFakeTimers();
		const bus = eventBus();
		const tracker = createSubagentActivityTracker({
			events: bus.events,
			requestTimeoutMs: 10_000,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(
			[...bus.listeners.keys()].some((channel) => channel.startsWith(SUBAGENT_RPC_REPLY_EVENT_PREFIX)),
		).toBe(true);

		tracker.dispose();

		expect([...bus.listeners.values()].reduce((total, handlers) => total + handlers.size, 0)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
