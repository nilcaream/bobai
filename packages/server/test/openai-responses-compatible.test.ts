import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { StreamEvent, ToolDefinition } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

function sseStream(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
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

describe("openai responses compatible provider", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends Responses API request with converted input and tools", async () => {
		const { createOpenAIResponsesCompatibleProvider } = await import("../src/provider/openai-responses-compatible");
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				sseStream([
					{ type: "response.output_text.delta", delta: "Hello" },
					{ type: "response.completed", response: { usage: { input_tokens: 42, output_tokens: 10, total_tokens: 52 } } },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;
		const tools: ToolDefinition[] = [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			},
		];

		const provider = createOpenAIResponsesCompatibleProvider({
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/responses",
			apiKey: "zen-key",
		});
		await collect(
			provider.stream({
				model: "gpt-5.4",
				messages: [
					{ role: "system", content: "Be helpful." },
					{ role: "user", content: "hello" },
				],
				tools,
			}),
		);

		expect(capturedUrl).toBe("https://opencode.ai/zen/v1/responses");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer zen-key");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("gpt-5.4");
		expect(body.stream).toBe(true);
		expect(body.input).toBeDefined();
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				strict: false,
			},
		]);
	});

	test("yields text, usage and stop finish from Responses SSE", async () => {
		const { createOpenAIResponsesCompatibleProvider } = await import("../src/provider/openai-responses-compatible");
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ type: "response.output_text.delta", delta: "Hello" },
					{ type: "response.output_text.delta", delta: " world" },
					{ type: "response.completed", response: { usage: { input_tokens: 42, output_tokens: 10, total_tokens: 52 } } },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenAIResponsesCompatibleProvider({
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/responses",
			apiKey: "zen-key",
		});
		const events = await collect(
			provider.stream({
				model: "gpt-5.4",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{
				type: "usage",
				tokenCount: 42,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | beta | 42 / 272000 | 0%",
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("yields tool call events and tool_calls finish from Responses SSE", async () => {
		const { createOpenAIResponsesCompatibleProvider } = await import("../src/provider/openai-responses-compatible");
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", call_id: "call_1", name: "read_file" },
					},
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '"foo.ts"}' },
					{ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenAIResponsesCompatibleProvider({
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/responses",
			apiKey: "zen-key",
		});
		const events = await collect(
			provider.stream({
				model: "gpt-5.4",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 20,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | beta | 20 / 272000 | 0%",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		const { createOpenAIResponsesCompatibleProvider } = await import("../src/provider/openai-responses-compatible");
		globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const provider = createOpenAIResponsesCompatibleProvider({
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/responses",
			apiKey: "zen-key",
		});
		await expect(async () => {
			for await (const _ of provider.stream({
				model: "gpt-5.4",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
		}).toThrow(ProviderError);
	});
});
