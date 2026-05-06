import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createAmazonBedrockProvider } from "../src/provider/amazon-bedrock";
import type { StreamEvent } from "../src/provider/provider";

function sseAnthropicStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 10 } } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
				{ type: "message_stop" },
			];
			for (const chunk of chunks) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
			}
			controller.close();
		},
	});
}

function sseChatStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			const chunks = [
				{ choices: [{ delta: { content: "hi" } }] },
				{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
				"[DONE]",
			];
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

describe("amazon-bedrock provider", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("routes anthropic.* models to the Bedrock Anthropic messages API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(sseAnthropicStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "bedrock-key", region: "us-east-1" });
		await collect(
			provider.stream({
				model: "anthropic.claude-opus-4-7",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(capturedUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("bedrock-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
	});

	test("routes non-anthropic models to the Bedrock chat completions API without /openai prefix", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(sseChatStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "bedrock-key", region: "us-east-1" });
		await collect(
			provider.stream({
				model: "deepseek.v3-v1:0",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(capturedUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
		expect(capturedUrl).not.toContain("/openai/");
		expect(capturedInit?.method).toBe("POST");
	});
});
