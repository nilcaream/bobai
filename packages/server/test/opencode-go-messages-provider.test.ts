import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { createOpenCodeGoProvider } from "../src/provider/opencode-go";
import type { StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";
import { createProviderModelsTempDir } from "./test-provider-models";

function sseStream(chunks: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				const payload = chunk === "[DONE]" ? "[DONE]" : JSON.stringify(chunk);
				controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
			}
			controller.close();
		},
	});
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe("opencode-go provider (messages)", () => {
	const originalFetch = globalThis.fetch;
	let configDir: string;

	beforeEach(() => {
		globalThis.fetch = originalFetch;
		configDir = createProviderModelsTempDir();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("routes MiniMax models to the OpenCode Go messages API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				sseStream([
					{ type: "message_start", message: { usage: { input_tokens: 12 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeGoProvider({ apiKey: "go-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "minimax-m2.7",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/messages");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("go-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["x-opencode-session"]).toBe("12345678");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("minimax-m2.7");
		expect(body.stream).toBe(true);
		expect(body.max_tokens).toBe(16384);
		expect(body.thinking).toEqual({
			type: "enabled",
			budget_tokens: 1024,
			display: "omitted",
		});
	});

	test("parses text, tool calls, usage and finish events from the messages SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ type: "message_start", message: { usage: { input_tokens: 12800 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
					{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read_file" } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"foo.ts"}' } },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 300 } },
					{ type: "message_stop" },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeGoProvider({ apiKey: "go-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "minimax-m2.7",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "tool_call_start", index: 1, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 1, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 1, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 12800,
				tokenLimit: 131072,
				display: "opencode-go | minimax-m2.7 | $0.80 | $3.00 | 12800 / 131072 | 10%",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("uses passed anthropic reasoning defaults in the messages request body", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(
				sseStream([
					{ type: "message_start", message: { usage: { input_tokens: 12 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeGoProvider({ apiKey: "go-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "minimax-m2.7",
				messages: [{ role: "user", content: "hello" }],
				reasoningDefaults: {
					anthropic: {
						budgetTokens: 2048,
						display: "summarized",
					},
				},
			}),
		);

		const body = JSON.parse(capturedInit?.body as string);
		expect(body.thinking).toEqual({
			type: "enabled",
			budget_tokens: 2048,
			display: "summarized",
		});
	});

	test("uses maxOutputTokens override for the messages API", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(
				sseStream([
					{ type: "message_start", message: { usage: { input_tokens: 12 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeGoProvider({ apiKey: "go-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "minimax-m2.7",
				messages: [{ role: "user", content: "hello" }],
				maxOutputTokens: 321,
			}),
		);

		const body = JSON.parse(capturedInit?.body as string);
		expect(body.max_tokens).toBe(321);
	});

	test("throws ProviderError on non-OK response from messages API", async () => {
		globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const provider = createOpenCodeGoProvider({ apiKey: "bad" }, undefined, globalThis.fetch, configDir);
		await expect(async () => {
			for await (const _ of provider.stream({
				model: "minimax-m2.7",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
		}).toThrow(ProviderError);
	});
});
