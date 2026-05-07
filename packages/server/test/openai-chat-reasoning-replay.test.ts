import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { getReasoningCapabilities } from "../src/provider/reasoning-capabilities";
import { createProviderModelsTempDir } from "./test-provider-models";

async function getModule() {
	return import("../src/provider/openai-chat-compatible");
}

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

describe("OpenAI chat reasoning replay", () => {
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

	test("serializes assistant reasoning_content into the matching assistant message for replay", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/deepseek-r1",
			apiFamily: "openai-chat-completions",
		});
		const { convertMessagesToOpenAIChat } = await getModule();

		const messages = convertMessagesToOpenAIChat(
			[
				{ role: "system", content: "Be helpful." },
				{ role: "user", content: "First" },
				{
					role: "assistant",
					content: "One",
					reasoning: [
						{ kind: "interleaved-chat", field: "reasoning_content", text: "think one" },
						{ kind: "text-summary", text: "ignore me" },
					],
				},
				{ role: "user", content: "Second" },
				{
					role: "assistant",
					content: "Two",
					reasoning: [{ kind: "interleaved-chat", field: "reasoning_content", text: "think two" }],
				},
			],
			capabilities,
		);

		expect(messages).toEqual([
			{ role: "system", content: "Be helpful." },
			{ role: "user", content: "First" },
			{ role: "assistant", content: "One", reasoning_content: "think one" },
			{ role: "user", content: "Second" },
			{ role: "assistant", content: "Two", reasoning_content: "think two" },
		]);
	});

	test("serializes assistant reasoning_details replay and keeps content null when needed", async () => {
		const capabilities = {
			family: "openai-chat-interleaved" as const,
			supportsReplay: true,
			assistantField: "reasoning_details" as const,
		};
		const { convertMessagesToOpenAIChat } = await getModule();

		const messages = convertMessagesToOpenAIChat(
			[
				{ role: "user", content: "Call tool" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
						},
					],
					reasoning: [{ kind: "interleaved-chat", field: "reasoning_details", details: { steps: [1, 2] } }],
				},
			],
			capabilities,
		);

		expect(messages).toEqual([
			{ role: "user", content: "Call tool" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
					},
				],
				reasoning_details: { steps: [1, 2] },
			},
		]);
	});

	test("request body replays assistant reasoning_details on the correct assistant message", async () => {
		const { createOpenAIChatCompatibleProvider } = await getModule();
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body));
			return new Response(sseStream(["[DONE]"]), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createOpenAIChatCompatibleProvider(
			{
				providerId: "opencode-zen",
				baseUrl: "https://example.invalid/chat/completions",
				apiKey: "test-key",
			},
			undefined,
			globalThis.fetch,
			configDir,
		);

		for await (const _event of provider.stream({
			model: "qwen3.6-plus",
			messages: [
				{ role: "user", content: "First" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
						},
					],
					reasoning: [{ kind: "interleaved-chat", field: "reasoning_details", details: { steps: [1, 2] } }],
				},
			],
		})) {
			// drain
		}

		expect(capturedBody?.messages).toEqual([
			{ role: "user", content: "First" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
					},
				],
				reasoning_details: { steps: [1, 2] },
			},
		]);
	});

	test("request body replays assistant reasoning on the correct assistant message", async () => {
		const { createOpenAIChatCompatibleProvider } = await getModule();
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body));
			return new Response(sseStream(["[DONE]"]), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createOpenAIChatCompatibleProvider(
			{
				providerId: "openrouter",
				baseUrl: "https://example.invalid/chat/completions",
				apiKey: "test-key",
			},
			undefined,
			globalThis.fetch,
			configDir,
		);

		for await (const _event of provider.stream({
			model: "openrouter/deepseek-r1",
			messages: [
				{ role: "user", content: "First" },
				{
					role: "assistant",
					content: "One",
					reasoning: [{ kind: "interleaved-chat", field: "reasoning_content", text: "think one" }],
				},
				{ role: "user", content: "Second" },
				{
					role: "assistant",
					content: "Two",
					reasoning: [{ kind: "interleaved-chat", field: "reasoning_content", text: "think two" }],
				},
			],
		})) {
			// drain
		}

		expect(capturedBody?.messages).toEqual([
			{ role: "user", content: "First" },
			{ role: "assistant", content: "One", reasoning_content: "think one" },
			{ role: "user", content: "Second" },
			{ role: "assistant", content: "Two", reasoning_content: "think two" },
		]);
	});
});
