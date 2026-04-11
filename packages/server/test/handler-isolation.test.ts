import { describe, expect, test } from "bun:test";
import { createIsolatedTurnProvider } from "../src/provider/isolated-turn";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";

/**
 * Simulates the handlePrompt pattern: create isolated provider, beginTurn,
 * stream some calls, read summary.
 */
async function simulateSession(
	provider: Provider,
	sessionPromptTokens: number,
	callCount: number,
): Promise<{ summary: string | undefined; promptTokens: number }> {
	const turnProvider = createIsolatedTurnProvider(provider);
	turnProvider.beginTurn?.(sessionPromptTokens);

	for (let i = 0; i < callCount; i++) {
		for await (const _e of turnProvider.stream({ model: "test-model", messages: [], initiator: "agent" })) {
		}
		// Simulate async interleaving
		await new Promise((r) => setTimeout(r, 0));
	}

	return {
		summary: turnProvider.getTurnSummary?.(),
		promptTokens: turnProvider.getTurnPromptTokens?.() ?? 0,
	};
}

function mockConcurrentProvider(): Provider {
	return {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text: "ok" };
			const initiator = opts.initiator ?? "agent";
			if (opts.onMetrics) {
				opts.onMetrics({ model: opts.model, promptTokens: 500, promptChars: 1200, totalTokens: 750, initiator });
			}
			yield { type: "finish", reason: "stop" };
		},
	};
}

describe("handler-level session isolation", () => {
	test("concurrent sessions get independent turn metrics", async () => {
		const provider = mockConcurrentProvider();

		const [sessionA, sessionB] = await Promise.all([
			simulateSession(provider, 0, 3), // new session, 3 calls
			simulateSession(provider, 10000, 2), // existing session, 2 calls
		]);

		// Session A: new session (baseline=0), 3 agent calls
		expect(sessionA.summary).toContain("agent: 3");
		expect(sessionA.summary).toContain("context: 500"); // absolute (baseline=0)
		expect(sessionA.promptTokens).toBe(500);

		// Session B: existing session (baseline=10000), 2 agent calls
		expect(sessionB.summary).toContain("agent: 2");
		expect(sessionB.summary).toContain("context: -9500"); // 500 - 10000
		expect(sessionB.promptTokens).toBe(500);
	});

	test("subagent save/restore on isolated provider doesn't leak to sibling session", async () => {
		const provider = mockConcurrentProvider();
		const parentA = createIsolatedTurnProvider(provider);
		parentA.beginTurn?.(5000);

		// Simulate parent making calls
		for await (const _e of parentA.stream({ model: "m", messages: [], initiator: "agent" })) {
		}

		// Simulate subagent: save parent state, begin child turn, run child, restore
		const parentState = parentA.saveTurnState?.();
		parentA.beginTurn?.(0); // child session

		// Meanwhile, another session runs concurrently
		const sessionB = createIsolatedTurnProvider(provider);
		sessionB.beginTurn?.(50000);
		for await (const _e of sessionB.stream({ model: "m", messages: [], initiator: "agent" })) {
		}

		// Child finishes
		for await (const _e of parentA.stream({ model: "m", messages: [], initiator: "agent" })) {
		}
		const childSummary = parentA.getTurnSummary?.();
		parentA.restoreTurnState?.(parentState);

		// Parent's restored state should be intact
		const parentSummary = parentA.getTurnSummary?.();
		expect(parentSummary).toContain("agent: 1"); // only parent's 1 call
		expect(childSummary).toContain("context: 500"); // child absolute

		// Session B should be completely independent
		const bSummary = sessionB.getTurnSummary?.();
		expect(bSummary).toContain("agent: 1");
		expect(bSummary).toContain("context: -49500"); // 500 - 50000
	});
});
