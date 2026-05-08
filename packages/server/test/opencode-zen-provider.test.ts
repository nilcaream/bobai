import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createOpenCodeZenProvider } from "../src/provider/opencode-zen";
import type { StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

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

describe("opencode-zen provider", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("routes Claude models to the OpenCode Zen messages API", async () => {
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

		const provider = createOpenCodeZenProvider({ apiKey: "zen-key" });
		await collect(
			provider.stream({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://opencode.ai/zen/v1/messages");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("zen-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers["x-opencode-session"]).toBe("12345678");
	});

	test("routes chat models to the OpenCode Zen chat completions API", async () => {
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
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeZenProvider({ apiKey: "zen-key" });
		await collect(
			provider.stream({
				model: "qwen3.6-plus",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer zen-key");
		expect(headers["x-opencode-session"]).toBe("12345678");
	});

	test("routes GPT models to the OpenCode Zen responses API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				sseStream([
					{ type: "response.output_text.delta", delta: "hi" },
					{ type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeZenProvider({ apiKey: "zen-key" });
		await collect(
			provider.stream({
				model: "gpt-5.4",
				messages: [{ role: "user", content: "hello" }],
				sessionId: "12345678-1234-1234-1234-123456789abc",
			}),
		);

		expect(capturedUrl).toBe("https://opencode.ai/zen/v1/responses");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer zen-key");
		expect(headers["x-opencode-session"]).toBe("12345678");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.input).toBeDefined();
		expect(body.messages).toBeUndefined();
	});

	test("emits reasoning events for interleaved reasoning_details deltas", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					{ choices: [{ delta: { reasoning_details: { steps: [1] } } }] },
					{ choices: [{ delta: { reasoning_details: { steps: [1, 2] } } }] },
					"[DONE]",
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const provider = createOpenCodeZenProvider({ apiKey: "zen-key" });
		const events = await collect(
			provider.stream({
				model: "qwen3.6-plus",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(events).toEqual([
			{ type: "reasoning_start", index: 0, reasoning: { kind: "interleaved-chat", field: "reasoning_details" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "details", details: { steps: [1] } } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "details", details: { steps: [1, 2] } } },
			{
				type: "reasoning_end",
				index: 0,
				reasoning: { kind: "interleaved-chat", field: "reasoning_details", details: { steps: [1, 2] } },
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const provider = createOpenCodeZenProvider({ apiKey: "bad" });
		await expect(async () => {
			for await (const _ of provider.stream({
				model: "qwen3.6-plus",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
		}).toThrow(ProviderError);
	});
});
