import { describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

function mockWs() {
	const sent: string[] = [];
	return {
		send(msg: string) {
			sent.push(msg);
		},
		messages() {
			return sent.map((s) => JSON.parse(s));
		},
	};
}

function mockProvider(tokens: string[]): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions) {
			for (const t of tokens) yield t;
		},
	};
}

function failingProvider(status: number, body: string): Provider {
	return {
		id: "mock",
		async *stream() {
			throw new ProviderError(status, body);
		},
	};
}

describe("handlePrompt", () => {
	test("streams provider tokens then done", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		await handlePrompt(ws, { type: "prompt", text: "hi" }, provider, "test-model");
		const msgs = ws.messages();
		expect(msgs.at(-1)).toEqual({ type: "done" });
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " world" },
		]);
	});

	test("sends error message on ProviderError", async () => {
		const ws = mockWs();
		const provider = failingProvider(401, "Unauthorized");
		await handlePrompt(ws, { type: "prompt", text: "hi" }, provider, "test-model");
		const msgs = ws.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("401");
	});
});
