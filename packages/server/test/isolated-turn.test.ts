import { describe, expect, test } from "bun:test";
import { createIsolatedTurnProvider } from "../src/provider/isolated-turn";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";

/** Create a mock provider that supports onMetrics routing. */
function mockProvider(): Provider {
	let turnModel = "";
	let turnCalls = 0;
	return {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text: "hello" };
			yield { type: "usage", tokenCount: 500, tokenLimit: 8000, display: "mock-model" };
			// Route metrics via onMetrics if provided, otherwise accumulate locally
			const initiator = opts.initiator ?? "agent";
			if (opts.onMetrics) {
				opts.onMetrics({ model: opts.model, promptTokens: 500, totalTokens: 750, initiator });
			} else {
				turnModel = opts.model;
				turnCalls++;
			}
			yield { type: "finish", reason: "stop" };
		},
		beginTurn() {
			turnModel = "started";
			turnCalls++;
		},
		getTurnSummary() {
			return ` | ${turnModel} | calls: ${turnCalls}`;
		},
		getTurnPromptTokens() {
			return 100;
		},
		saveTurnState() {
			return { turnModel, turnCalls };
		},
		restoreTurnState(s: unknown) {
			const state = s as { turnModel: string; turnCalls: number };
			turnModel = state.turnModel;
			turnCalls = state.turnCalls;
		},
	};
}

describe("createIsolatedTurnProvider", () => {
	test("delegates stream to the original provider and yields all events", async () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		const events: StreamEvent[] = [];
		for await (const event of isolated.stream({ model: "m", messages: [] })) {
			events.push(event);
		}
		expect(events).toEqual([
			{ type: "text", text: "hello" },
			{ type: "usage", tokenCount: 500, tokenLimit: 8000, display: "mock-model" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("preserves the original provider's id", () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		expect(isolated.id).toBe("mock");
	});

	test("beginTurn on isolated provider does not affect the original", () => {
		const original = mockProvider();
		original.beginTurn?.();
		expect(original.getTurnSummary?.()).toBe(" | started | calls: 1");

		const isolated = createIsolatedTurnProvider(original);
		isolated.beginTurn?.(42);

		expect(original.getTurnSummary?.()).toBe(" | started | calls: 1");
		const isoSummary = isolated.getTurnSummary?.();
		expect(isoSummary).toBeDefined();
		expect(isoSummary).toContain("agent: 0");
	});

	test("two isolated providers from same original don't interfere", () => {
		const original = mockProvider();
		const a = createIsolatedTurnProvider(original);
		const b = createIsolatedTurnProvider(original);

		a.beginTurn?.(10);
		b.beginTurn?.(20);

		const aSummary = a.getTurnSummary?.();
		const bSummary = b.getTurnSummary?.();
		expect(aSummary).toContain("context: -10");
		expect(bSummary).toContain("context: -20");
	});

	test("saveTurnState / restoreTurnState works independently", () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);

		isolated.beginTurn?.(50);
		const saved = isolated.saveTurnState?.();
		isolated.beginTurn?.(999);
		isolated.restoreTurnState?.(saved);
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("context: -50");
	});

	test("save/restore on isolated does not affect original", () => {
		const original = mockProvider();
		original.beginTurn?.();
		const originalSummaryBefore = original.getTurnSummary?.();

		const isolated = createIsolatedTurnProvider(original);
		isolated.beginTurn?.(100);
		const saved = isolated.saveTurnState?.();
		isolated.beginTurn?.(200);
		isolated.restoreTurnState?.(saved);

		expect(original.getTurnSummary?.()).toBe(originalSummaryBefore);
	});

	test("getTurnSummary returns undefined before any beginTurn call", () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		expect(isolated.getTurnSummary?.()).toBeUndefined();
	});

	test("restoreTurnState preserves all turn tracking fields", () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);

		const customState = {
			turnStartTime: 1000,
			turnModel: "gpt-4o",
			turnAgentCalls: 5,
			turnUserCalls: 2,
			turnPremiumCost: 3.5,
			turnTokens: 12000,
			turnLastCallTokens: 8000,
			baselineTokens: 6000,
		};
		isolated.restoreTurnState?.(customState);

		expect(isolated.getTurnPromptTokens?.()).toBe(8000);
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("gpt-4o");
		expect(summary).toContain("agent: 5");
		expect(summary).toContain("user: 2");
		expect(summary).toContain("premium: 3.50");
		expect(summary).toContain("tokens: 12000");
		expect(summary).toContain("context: +2000");
	});

	test("stream routes metrics to isolated provider via onMetrics", async () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		isolated.beginTurn?.(0);

		// Stream through the isolated provider — onMetrics should route to its locals
		for await (const _event of isolated.stream({ model: "test-model", messages: [], initiator: "agent" })) {
			// consume all events
		}

		// The isolated provider should have accumulated metrics from onMetrics
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("test-model");
		expect(summary).toContain("agent: 1");
		expect(summary).toContain("tokens: 750");
		expect(summary).toContain("context: 500"); // promptTokens=500, baselineTokens=0

		// The original should NOT have been affected
		expect(original.getTurnSummary?.()).not.toContain("test-model");
	});

	test("two isolated providers streaming concurrently track independently", async () => {
		const original = mockProvider();
		const a = createIsolatedTurnProvider(original);
		const b = createIsolatedTurnProvider(original);
		a.beginTurn?.(0);
		b.beginTurn?.(0);

		// Run both streams concurrently
		const streamA = async () => {
			for await (const _e of a.stream({ model: "model-a", messages: [], initiator: "agent" })) {
			}
		};
		const streamB = async () => {
			for await (const _e of b.stream({ model: "model-b", messages: [], initiator: "agent" })) {
			}
		};
		await Promise.all([streamA(), streamB()]);

		const aSummary = a.getTurnSummary?.();
		const bSummary = b.getTurnSummary?.();
		expect(aSummary).toContain("model-a");
		expect(aSummary).toContain("agent: 1");
		expect(bSummary).toContain("model-b");
		expect(bSummary).toContain("agent: 1");
	});
});
