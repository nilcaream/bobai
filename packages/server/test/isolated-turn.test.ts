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
			if (opts.onMetrics) {
				opts.onMetrics({
					model: opts.model,
					promptTokens: 500,
					outputTokens: 250,
					promptChars: 1200,
					totalTokens: 750,
				});
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

function accumulatingMockProvider(): Provider {
	return {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text: "tool roundtrip" };
			opts.onMetrics?.({
				model: opts.model,
				promptTokens: 100,
				outputTokens: 40,
				promptChars: 300,
				totalTokens: 140,
			});
			opts.onMetrics?.({
				model: opts.model,
				promptTokens: 250,
				outputTokens: 10,
				promptChars: 900,
				totalTokens: 260,
			});
			yield { type: "finish", reason: "stop" };
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
		expect(isoSummary).toBeUndefined();
	});

	test("two isolated providers from same original don't interfere", () => {
		const original = mockProvider();
		const a = createIsolatedTurnProvider(original);
		const b = createIsolatedTurnProvider(original);

		a.beginTurn?.(10);
		b.beginTurn?.(20);

		const aSummary = a.getTurnSummary?.();
		const bSummary = b.getTurnSummary?.();
		expect(aSummary).toBeUndefined();
		expect(bSummary).toBeUndefined();
	});

	test("saveTurnState / restoreTurnState works independently", () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);

		isolated.beginTurn?.(50);
		const saved = isolated.saveTurnState?.();
		isolated.beginTurn?.(999);
		isolated.restoreTurnState?.(saved);
		const summary = isolated.getTurnSummary?.();
		expect(summary).toBeUndefined();
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
			turnInputTokens: 8000,
			turnOutputTokens: 4000,
			turnLastCallChars: 25000,
			baselineTokens: 6000,
		};
		isolated.restoreTurnState?.(customState);

		expect(isolated.getTurnPromptTokens?.()).toBe(8000);
		expect(isolated.getTurnPromptChars?.()).toBe(25000);
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("gpt-4o");
		expect(summary).toContain("in: 8000");
		expect(summary).toContain("out: 4000");
		expect(summary).toContain("context: +2000");
	});

	test("stream routes metrics to isolated provider via onMetrics", async () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		isolated.beginTurn?.(0);

		// Stream through the isolated provider — onMetrics should route to its locals
		for await (const _event of isolated.stream({ model: "test-model", messages: [] })) {
			// consume all events
		}

		// The isolated provider should have accumulated metrics from onMetrics
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("test-model");
		expect(summary).toContain("in: 500");
		expect(summary).toContain("out: 250");
		expect(summary).toContain("context: +500"); // promptTokens=500, baselineTokens=0

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
			for await (const _e of a.stream({ model: "model-a", messages: [] })) {
			}
		};
		const streamB = async () => {
			for await (const _e of b.stream({ model: "model-b", messages: [] })) {
			}
		};
		await Promise.all([streamA(), streamB()]);

		const aSummary = a.getTurnSummary?.();
		const bSummary = b.getTurnSummary?.();
		expect(aSummary).toContain("model-a");
		expect(aSummary).toContain("in: 500");
		expect(bSummary).toContain("model-b");
		expect(bSummary).toContain("in: 500");
	});

	test("nested isolated providers route metrics to the innermost wrapper", async () => {
		const original = mockProvider();
		const outer = createIsolatedTurnProvider(original);
		const inner = createIsolatedTurnProvider(outer);
		outer.beginTurn?.(0);
		inner.beginTurn?.(0);

		for await (const _event of inner.stream({ model: "nested-model", messages: [] })) {
			// consume all events
		}

		const innerSummary = inner.getTurnSummary?.();
		expect(innerSummary).toContain("nested-model");
		expect(innerSummary).toContain("in: 500");
		expect(innerSummary).toContain("out: 250");

		const outerSummary = outer.getTurnSummary?.();
		expect(outerSummary).toContain("nested-model");
		expect(outerSummary).toContain("in: 500");
		expect(outerSummary).toContain("out: 250");
	});

	test("getTurnPromptChars returns chars from onMetrics", async () => {
		const original = mockProvider();
		const isolated = createIsolatedTurnProvider(original);
		isolated.beginTurn?.(0);
		for await (const _e of isolated.stream({ model: "m", messages: [] })) {
		}
		expect(isolated.getTurnPromptChars?.()).toBe(1200);
	});

	test("summary uses total in/out across multiple provider calls but keeps context from last call", async () => {
		const isolated = createIsolatedTurnProvider(accumulatingMockProvider());
		isolated.beginTurn?.(80);
		for await (const _e of isolated.stream({ model: "total-model", messages: [] })) {
		}
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("in: 350");
		expect(summary).toContain("out: 50");
		expect(summary).toContain("context: +170");
	});

	test("restoreTurnState preserves total and last-call counters independently", () => {
		const isolated = createIsolatedTurnProvider(accumulatingMockProvider());
		const customState = {
			turnStartTime: 1000,
			turnModel: "gpt-4o",
			turnInputTokens: 250,
			turnOutputTokens: 10,
			turnTotalInputTokens: 350,
			turnTotalOutputTokens: 50,
			turnLastCallChars: 900,
			baselineTokens: 80,
		};
		isolated.restoreTurnState?.(customState);
		expect(isolated.getTurnPromptTokens?.()).toBe(250);
		expect(isolated.getTurnPromptChars?.()).toBe(900);
		const summary = isolated.getTurnSummary?.();
		expect(summary).toContain("in: 350");
		expect(summary).toContain("out: 50");
		expect(summary).toContain("context: +170");
	});
});
