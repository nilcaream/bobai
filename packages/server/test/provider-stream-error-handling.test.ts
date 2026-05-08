import { describe, expect, test } from "bun:test";
import { createOpenAIChatCompatibleProvider } from "../src/provider/openai-chat-compatible";
import type { StreamEvent } from "../src/provider/provider";

/**
 * These tests verify that providers properly detect and propagate network
 * errors and incomplete stream conditions, rather than silently completing.
 */

describe("Provider stream error handling", () => {
	describe("openai-chat-compatible", () => {
		test("throws error when stream ends without finish_reason and no content", async () => {
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
				}) as unknown as typeof fetch;

			const provider = createOpenAIChatCompatibleProvider(
				{
					providerId: "opencode-go",
					baseUrl: "https://example.invalid/chat/completions",
					apiKey: "test-key",
				},
				undefined,
				mockFetch,
				"/tmp/test-config",
			);

			await expect(
				(async () => {
					for await (const _event of provider.stream({
						model: "test-model",
						messages: [{ role: "user", content: "Hello" }],
					})) {
						// consume stream
					}
				})(),
			).rejects.toThrow("Stream ended unexpectedly without receiving any content");
		});

		test("completes successfully when stream ends with proper finish_reason", async () => {
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"total_tokens":12}}\n\n',
								),
							);
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							controller.close();
						},
					}),
				}) as unknown as typeof fetch;

			const provider = createOpenAIChatCompatibleProvider(
				{
					providerId: "opencode-go",
					baseUrl: "https://example.invalid/chat/completions",
					apiKey: "test-key",
				},
				undefined,
				mockFetch,
				"/tmp/test-config",
			);

			const events: StreamEvent[] = [];
			for await (const event of provider.stream({
				model: "test-model",
				messages: [{ role: "user", content: "Hello" }],
			})) {
				events.push(event);
			}

			const textEvents = events.filter((e) => e.type === "text");
			const finishEvents = events.filter((e) => e.type === "finish");

			expect(textEvents.length).toBe(1);
			expect(textEvents[0]).toEqual({ type: "text", text: "Hello" });
			expect(finishEvents.length).toBe(1);
			expect(finishEvents[0]).toEqual({ type: "finish", reason: "stop" });
		});

		test("propagates stream errors", async () => {
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
							controller.error(new Error("Network connection reset"));
						},
					}),
				}) as unknown as typeof fetch;

			const provider = createOpenAIChatCompatibleProvider(
				{
					providerId: "opencode-go",
					baseUrl: "https://example.invalid/chat/completions",
					apiKey: "test-key",
				},
				undefined,
				mockFetch,
				"/tmp/test-config",
			);

			await expect(
				(async () => {
					for await (const _event of provider.stream({
						model: "test-model",
						messages: [{ role: "user", content: "Hello" }],
					})) {
						// consume stream
					}
				})(),
			).rejects.toThrow();
		});

		test("allows partial content without finish_reason (graceful degradation)", async () => {
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial response"}}]}\n\n'));
							controller.close();
						},
					}),
				}) as unknown as typeof fetch;

			const provider = createOpenAIChatCompatibleProvider(
				{
					providerId: "opencode-go",
					baseUrl: "https://example.invalid/chat/completions",
					apiKey: "test-key",
				},
				undefined,
				mockFetch,
				"/tmp/test-config",
			);

			const events: StreamEvent[] = [];
			for await (const event of provider.stream({
				model: "test-model",
				messages: [{ role: "user", content: "Hello" }],
			})) {
				events.push(event);
			}

			const textEvents = events.filter((e) => e.type === "text");
			const finishEvents = events.filter((e) => e.type === "finish");

			expect(textEvents.length).toBe(1);
			expect(textEvents[0]).toEqual({ type: "text", text: "Partial response" });
			expect(finishEvents.length).toBe(1);
		});
	});

	describe("convertMessagesToOpenAIChat", () => {
		test("filters out assistant messages with empty content and no tool_calls", async () => {
			const { convertMessagesToOpenAIChat } = await import("../src/provider/openai-chat-compatible");

			const messages = [
				{ role: "user" as const, content: "Hello" },
				{ role: "assistant" as const, content: "", tool_calls: [] },
				{ role: "assistant" as const, content: "  ", tool_calls: [] },
				{ role: "assistant" as const, content: "Valid response", tool_calls: [] },
				{
					role: "assistant" as const,
					content: "",
					tool_calls: [{ id: "1", type: "function" as const, function: { name: "test", arguments: "{}" } }],
				},
			];

			const result = convertMessagesToOpenAIChat(messages);

			expect(result.length).toBe(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("assistant");
			expect(result[1].content).toBe("Valid response");
			expect(result[2].role).toBe("assistant");
			expect(result[2].tool_calls?.length).toBe(1);
		});

		test("keeps assistant messages with content even if empty tool_calls", async () => {
			const { convertMessagesToOpenAIChat } = await import("../src/provider/openai-chat-compatible");

			const messages = [{ role: "assistant" as const, content: "Text and tools", tool_calls: [] }];

			const result = convertMessagesToOpenAIChat(messages);

			expect(result.length).toBe(1);
			expect(result[0].content).toBe("Text and tools");
		});
	});

	describe("convertMessagesToAnthropic", () => {
		test("filters out assistant messages with empty content and no tool_calls", async () => {
			const { convertMessagesToAnthropic } = await import("../src/provider/anthropic-convert");

			const messages = [
				{ role: "user" as const, content: "Hello" },
				{ role: "assistant" as const, content: "" },
				{ role: "assistant" as const, content: "Valid response" },
			];

			const result = convertMessagesToAnthropic(messages);

			expect(result.messages.length).toBe(2);
			expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
			expect(result.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Valid response" }] });
		});
	});

	describe("convertMessagesToBedrockConverse", () => {
		test("filters out assistant messages with empty content and no tool_calls", async () => {
			const { convertMessagesToConverse } = await import("../src/provider/bedrock-converse-convert");

			const messages = [
				{ role: "user" as const, content: "Hello", name: undefined },
				{ role: "assistant" as const, content: "" },
				{ role: "assistant" as const, content: "Valid response" },
			];

			const result = convertMessagesToConverse(messages);

			expect(result.messages.length).toBe(2);
			expect(result.messages[0]).toEqual({ role: "user", content: [{ text: "Hello" }] });
			expect(result.messages[1]).toEqual({ role: "assistant", content: [{ text: "Valid response" }] });
		});
	});
});
