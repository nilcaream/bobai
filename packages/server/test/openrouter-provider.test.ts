import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { createOpenRouterProvider } from "../src/provider/openrouter";
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

describe("openrouter provider", () => {
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

	test("sends correct request to OpenRouter chat completions API", async () => {
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

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer or-key");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["HTTP-Referer"]).toBe("https://github.com/nilcaream/bobai");
		expect(headers["X-OpenRouter-Title"]).toBe("Bob AI");
		expect(headers["X-OpenRouter-Categories"]).toBe("cli-agent");
		expect(headers["x-session-affinity"]).toBe("12345678");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("openrouter/free");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	test("yields text, tool-call, usage and finish events from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "Hello" } }] },
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

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "anthropic/claude-haiku-4.5",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 12800,
				tokenLimit: 128000,
				display: "openrouter | anthropic/claude-haiku-4.5 [$0.50 $5.12] | $0.00 | 12800 / 128000 | 10%",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("treats chat-compatible tool calls as tool_calls even when finish_reason is stop", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_1", type: "function", function: { name: "list_directory", arguments: "" } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"."}' } }] } }] },
					{
						choices: [{ finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
					},
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":"."}' },
			{
				type: "usage",
				tokenCount: 10,
				tokenLimit: 200000,
				display: "openrouter | openrouter/free [$0.00 $0.00] | $0.00 | 10 / 200000 | 0%",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("emits reasoning events for openrouter deepseek reasoning deltas", async () => {
		// OpenRouter normalizes deepseek reasoning to "reasoning" field, not "reasoning_content".
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { reasoning: "thinking" } }] },
					{ choices: [{ delta: { content: "Answer" } }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "openrouter/deepseek-r1",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "reasoning_start", index: 0, reasoning: { kind: "interleaved-chat", field: "reasoning" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "thinking" } },
			{ type: "text", text: "Answer" },
			{
				type: "reasoning_end",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning", text: "thinking" },
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("ignores null reasoning termination chunk — does not append 'null' to reasoning text", async () => {
		// Real APIs send a final chunk with reasoning: null to signal end of reasoning.
		// Before the fix, `!== undefined` let null through and "null" was appended to the text.
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { reasoning: "thinking hard" } }] },
					{ choices: [{ delta: { reasoning: null } }] },
					{ choices: [{ delta: { content: "Answer" } }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "openrouter/deepseek-r1",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "reasoning_start", index: 0, reasoning: { kind: "interleaved-chat", field: "reasoning" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "thinking hard" } },
			{ type: "text", text: "Answer" },
			{
				type: "reasoning_end",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning", text: "thinking hard" },
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const provider = createOpenRouterProvider({ apiKey: "bad" }, undefined, globalThis.fetch, configDir);
		await expect(async () => {
			for await (const _ of provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
		}).toThrow(ProviderError);
	});

	test("emits reasoning events for openrouter gemini reasoning deltas", async () => {
		// OpenRouter normalizes gemini reasoning to the "reasoning" delta field.
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { reasoning: "**Exploring**\n" } }] },
					{ choices: [{ delta: { reasoning: "I'm thinking" } }] },
					{ choices: [{ delta: { content: "Answer" } }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "google/gemini-2.5-pro",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{
				type: "reasoning_start",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning" },
			},
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "**Exploring**\n" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "I'm thinking" } },
			{ type: "text", text: "Answer" },
			{
				type: "reasoning_end",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning", text: "**Exploring**\nI'm thinking" },
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("gracefully handles finish_reason: error, preserving accumulated content", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "partial response" } }] },
					{ choices: [{ finish_reason: "error", delta: {} }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		// Should yield the accumulated content and finish as stop, NOT throw.
		expect(events).toEqual([
			{ type: "text", text: "partial response" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("sends prompt_cache_key when model supports caching", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "hi" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "test-session-123",
			}),
		);

		expect(capturedBody?.prompt_cache_key).toBe("test-session-123");
	});

	test("omits prompt_cache_key when model does not support caching", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "hi" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		// anthropic/claude-haiku-4.5 has supportsCaching: true, but we'll use
		// a non-existent model that won't match any config, so supportsCaching = undefined.
		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		await collect(
			provider.stream({
				model: "nonexistent/model",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "test-session-123",
			}),
		);

		expect(capturedBody?.prompt_cache_key).toBeUndefined();
	});

	test("reads cache_write_tokens from prompt_tokens_details", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { content: "hi" } }] },
					{
						choices: [{ finish_reason: "stop" }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 2,
							total_tokens: 12,
							prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
						},
					},
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "openrouter/free",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		const usageEvent = events.find((e): e is Extract<StreamEvent, { type: "usage" }> => e.type === "usage");
		expect(usageEvent?.cachedInputTokens).toBe(8);
		expect(usageEvent?.cacheCreationInputTokens).toBe(2);
	});

	test("accumulates incremental reasoning_details array fragments across chunks", async () => {
		// OpenRouter normalizes deepseek/gemini reasoning into an incremental
		// reasoning_details array where every chunk carries the next fragment and
		// `index` stays 0. The final accumulated details array must contain the
		// FULL concatenated text, not just the last fragment.
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						choices: [
							{
								delta: {
									reasoning: "The",
									reasoning_details: [{ type: "reasoning.text", text: "The", format: "unknown", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning: " auth",
									reasoning_details: [{ type: "reasoning.text", text: " auth", format: "unknown", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning: " is",
									reasoning_details: [{ type: "reasoning.text", text: " is", format: "unknown", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning: " hard.",
									reasoning_details: [{ type: "reasoning.text", text: " hard.", format: "unknown", index: 0 }],
								},
							},
						],
					},
					{ choices: [{ delta: { content: "Answer" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "deepseek/deepseek-v4-flash-0731",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const endEvent = events.find((e) => e.type === "reasoning_end");
		expect(endEvent).toEqual({
			type: "reasoning_end",
			index: 0,
			reasoning: {
				kind: "interleaved-chat",
				field: "reasoning_details",
				details: [{ type: "reasoning.text", text: "The auth is hard.", format: "unknown", index: 0 }],
			},
		});
	});

	test("merges consecutive reasoning.summary fragments but opens new entry on type change", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.text", text: "Step 1. ", format: "openai-responses-v1", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.text", text: "Step 2.", format: "openai-responses-v1", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning_details: [
										{ type: "reasoning.summary", summary: " Summary here", format: "openai-responses-v1", index: 0 },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { content: "Answer" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "qwen/qwen3.6-plus",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const endEvent = events.find((e) => e.type === "reasoning_end");
		// reasoning.text fragments concatenate into one entry; the reasoning.summary
		// fragment (a different type) opens a new entry.
		expect(endEvent).toEqual({
			type: "reasoning_end",
			index: 0,
			reasoning: {
				kind: "interleaved-chat",
				field: "reasoning_details",
				details: [
					{ type: "reasoning.text", text: "Step 1. Step 2.", format: "openai-responses-v1", index: 0 },
					{ type: "reasoning.summary", summary: " Summary here", format: "openai-responses-v1", index: 0 },
				],
			},
		});
	});

	test("keeps encrypted reasoning_details entries as discrete items (not merged)", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.encrypted", data: "AY90...", format: "google-gemini-v1", index: 0 }],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.encrypted", data: "AY91...", format: "google-gemini-v1", index: 0 }],
								},
							},
						],
					},
					{ choices: [{ delta: { content: "Answer" } }] },
					{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenRouterProvider({ apiKey: "or-key" }, undefined, globalThis.fetch, configDir);
		const events = await collect(
			provider.stream({
				model: "google/gemini-2.5-pro",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const endEvent = events.find((e) => e.type === "reasoning_end");
		expect(endEvent).toEqual({
			type: "reasoning_end",
			index: 0,
			reasoning: {
				kind: "interleaved-chat",
				field: "reasoning_details",
				details: [
					{ type: "reasoning.encrypted", data: "AY90...", format: "google-gemini-v1", index: 0 },
					{ type: "reasoning.encrypted", data: "AY91...", format: "google-gemini-v1", index: 0 },
				],
			},
		});
	});
});
