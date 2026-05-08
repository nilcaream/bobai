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
			// Simulate a network interruption: stream closes cleanly without any content or proper termination
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							// Stream closes immediately without any data (simulating connection drop before first chunk)
							controller.close();
						},
					}),
				} as Response);

			const provider = createOpenAIChatCompatibleProvider(
				{ providerId: "opencode-go", baseUrl: "https://test", apiKey: "test" },
				undefined,
				mockFetch,
			);

			await expect(
				(async () => {
					for await (const _event of provider.stream({
						model: "test-model",
						messages: [{ role: "user", content: "Hello" }],
					})) {
						// consume
					}
				})(),
			).rejects.toThrow("Stream ended unexpectedly");
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
									'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"total_tokens":15}}\n\n',
								),
							);
							controller.close();
						},
					}),
				} as Response);

			const provider = createOpenAIChatCompatibleProvider(
				{ providerId: "opencode-go", baseUrl: "https://test", apiKey: "test" },
				undefined,
				mockFetch,
			);

			const events: StreamEvent[] = [];

			for await (const event of provider.stream({
				model: "test-model",
				messages: [{ role: "user", content: "Hello" }],
			})) {
				events.push(event);
			}

			const finishEvents = events.filter((e) => e.type === "finish");
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
				} as Response);

			const provider = createOpenAIChatCompatibleProvider(
				{ providerId: "opencode-go", baseUrl: "https://test", apiKey: "test" },
				undefined,
				mockFetch,
			);

			await expect(
				(async () => {
					for await (const _event of provider.stream({
						model: "test-model",
						messages: [{ role: "user", content: "Hello" }],
					})) {
						// consume
					}
				})(),
			).rejects.toThrow("Network connection reset");
		});

		test("allows partial content without finish_reason (graceful degradation)", async () => {
			// If content was received but stream ends without finish_reason,
			// we should still yield the content and finish gracefully
			const mockFetch = () =>
				Promise.resolve({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial response"}}]}\n\n'));
							// Stream closes without sending finish_reason
							controller.close();
						},
					}),
				} as Response);

			const provider = createOpenAIChatCompatibleProvider(
				{ providerId: "opencode-go", baseUrl: "https://test", apiKey: "test" },
				undefined,
				mockFetch,
			);

			const events: StreamEvent[] = [];

			for await (const event of provider.stream({
				model: "test-model",
				messages: [{ role: "user", content: "Hello" }],
			})) {
				events.push(event);
			}

			// Should get the partial text and a finish event
			const textEvents = events.filter((e) => e.type === "text");
			const finishEvents = events.filter((e) => e.type === "finish");

			expect(textEvents.length).toBe(1);
			expect(textEvents[0]).toEqual({ type: "text", text: "Partial response" });
			expect(finishEvents.length).toBe(1);
		});
	});
});
