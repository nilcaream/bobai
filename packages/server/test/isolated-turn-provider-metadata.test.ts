import { describe, expect, test } from "bun:test";
import { createIsolatedTurnProvider } from "../src/provider/isolated-turn";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";

function makeProvider(id: "github-copilot" | "openrouter", model: string): Provider {
	return {
		id,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			options.onMetrics?.({
				model,
				promptTokens: 1000,
				outputTokens: 500,
				promptChars: 120,
				totalTokens: 1500,
				initiator: options.initiator ?? "user",
			});
			yield { type: "finish", reason: "stop" };
		},
	};
}

describe("isolated turn provider metadata", () => {
	test("formats github-copilot summaries from provider descriptor metadata", async () => {
		const provider = createIsolatedTurnProvider(makeProvider("github-copilot", "gpt-5-mini"));
		provider.beginTurn?.(0);
		for await (const _ of provider.stream({ model: "gpt-5-mini", messages: [] })) {
		}
		expect(provider.getTurnSummary?.()).toMatch(
			/^ \| gpt-5-mini \| 0x \| in: 1000 \| out: 500 \| context: \+1000 \| \d+\.\d{2}s$/,
		);
	});

	test("formats openrouter summaries from provider descriptor metadata", async () => {
		const provider = createIsolatedTurnProvider(makeProvider("openrouter", "openrouter/free"));
		provider.beginTurn?.(0);
		for await (const _ of provider.stream({ model: "openrouter/free", messages: [] })) {
		}
		expect(provider.getTurnSummary?.()).toMatch(/^ \| free \| in: 1000 \| out: 500 \| free \| context: \+1000 \| \d+\.\d{2}s$/);
	});
});
