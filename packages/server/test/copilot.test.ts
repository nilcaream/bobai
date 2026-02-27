import { afterEach, describe, expect, mock, test } from "bun:test";
import { createCopilotProvider } from "../src/provider/copilot";
import type { StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
	const text = events.map((e) => `data: ${e}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function chatChunk(content: string): string {
	return JSON.stringify({ choices: [{ delta: { content } }] });
}

describe("CopilotProvider", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("has correct id", () => {
		const provider = createCopilotProvider("tok");
		expect(provider.id).toBe("github-copilot");
	});

	test("sends correct request to Copilot API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider("test-token");
		const tokens: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hello" }],
		})) {
			tokens.push(t);
		}

		expect(capturedUrl).toBe("https://api.githubcopilot.com/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-token");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
		expect(headers["User-Agent"]).toMatch(/^bobai\//);
		expect(headers["x-initiator"]).toBe("user");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("gpt-5-mini");
		expect(body.stream).toBe(true);
	});

	test("yields content tokens from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(sseStream([chatChunk("Hello"), chatChunk(" world"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		const provider = createCopilotProvider("bad-token");
		const iter = provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		});

		expect(async () => {
			for await (const _ of iter) {
				/* drain */
			}
		}).toThrow(ProviderError);
	});

	test("skips chunks with no delta content", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(sseStream([JSON.stringify({ choices: [{ delta: {} }] }), chatChunk("only"), "[DONE]"]), {
				status: 200,
			});
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "only" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("config headers override default headers", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider("tok", {
			"User-Agent": "CustomAgent/2.0",
			"X-Custom": "value",
		});
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toBe("CustomAgent/2.0");
		expect(headers["X-Custom"]).toBe("value");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
	});

	test("uses default headers when no config headers provided", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toMatch(/^bobai\//);
	});

	test("sets x-initiator to agent when last message is not from user", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-initiator"]).toBe("agent");
	});
});
