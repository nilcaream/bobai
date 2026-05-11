import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createIsolatedTurnProvider } from "../src/provider/isolated-turn";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createProviderModelsTempDir } from "./test-provider-models";

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
			});
			yield { type: "finish", reason: "stop" };
		},
	};
}

const configDir = createProviderModelsTempDir();

afterAll(() => {
	fs.rmSync(configDir, { recursive: true, force: true });
});

describe("isolated turn provider metadata", () => {
	test("formats github-copilot summaries from provider descriptor metadata", async () => {
		const provider = createIsolatedTurnProvider(makeProvider("github-copilot", "gpt-5-mini"), configDir);
		provider.beginTurn?.(0);
		for await (const _ of provider.stream({ model: "gpt-5-mini", messages: [] })) {
		}
		expect(provider.getTurnSummary?.()).toMatch(/^ \| gpt-5-mini \| \[0x\] \| in: 1000 \| out: 500 \| \+1000 \| \d+\.\d{2}s$/);
	});

	test("formats openrouter summaries from provider descriptor metadata", async () => {
		const provider = createIsolatedTurnProvider(makeProvider("openrouter", "openrouter/free"), configDir);
		provider.beginTurn?.(0);
		for await (const _ of provider.stream({ model: "openrouter/free", messages: [] })) {
		}
		expect(provider.getTurnSummary?.()).toMatch(/^ \| free \| in: 1000 \| out: 500 \| free \| \+1000 \| \d+\.\d{2}s$/);
	});
});
