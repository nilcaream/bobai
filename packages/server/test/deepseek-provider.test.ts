import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { createDeepSeekProvider } from "../src/provider/deepseek";
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

describe("deepseek provider", () => {
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

	test("sends correct request to DeepSeek chat completions API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "hi" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
					"[DONE]",
				]),
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		}) as typeof fetch;

		const provider = createDeepSeekProvider({ apiKey: "ds-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer ds-key");
		expect(headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("deepseek-v4-flash");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	test("yields text and usage events from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "Hello from DeepSeek" } }] },
					{
						choices: [{ finish_reason: "stop" }],
						usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
					},
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createDeepSeekProvider({ apiKey: "ds-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "text", text: "Hello from DeepSeek" },
			{
				type: "usage",
				tokenCount: 500,
				tokenLimit: 1000000,
				display: "deepseek | deepseek-v4-flash [$0.14 $0.28] | $0.00 | 500 / 1000000 | 0%",
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("yields tool call events from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"foo.ts"}' } }] } }] },
					{
						choices: [{ finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 12800, completion_tokens: 300, total_tokens: 13100 },
					},
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createDeepSeekProvider({ apiKey: "ds-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "deepseek-v4-pro",
				messages: [{ role: "user", content: "read file" }],
			}),
		);

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 12800,
				tokenLimit: 1000000,
				display: "deepseek | deepseek-v4-pro [$1.74 $3.48] | $0.00 | 12800 / 1000000 | 1%",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("emits reasoning events for deepseek interleaved reasoning_content deltas", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { reasoning_content: "Let me think about this" } }] },
					{ choices: [{ delta: { content: "Answer" } }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createDeepSeekProvider({ apiKey: "ds-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "think please" }],
			}),
		);

		expect(events).toEqual([
			{ type: "reasoning_start", index: 0, reasoning: { kind: "interleaved-chat", field: "reasoning_content" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "Let me think about this" } },
			{ type: "text", text: "Answer" },
			{
				type: "reasoning_end",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "Let me think about this" },
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const provider = createDeepSeekProvider({ apiKey: "bad" }, undefined, globalThis.fetch, configDir);
		await expect(async () => {
			for await (const _ of provider.stream({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
		}).toThrow(ProviderError);
	});
});
