import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { parseAnthropicStream } from "../src/provider/anthropic-stream";
import type { StreamEvent } from "../src/provider/provider";
import { createProviderModelsTempDir } from "./test-provider-models";

// biome-ignore lint/suspicious/noExplicitAny: Anthropic SSE events are untyped objects with varying shapes
function mockAnthropicEvents(events: any[]): AsyncIterable<Record<string, unknown>> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

const configDir = createProviderModelsTempDir();

afterAll(() => {
	fs.rmSync(configDir, { recursive: true, force: true });
});

describe("parseAnthropicStream", () => {
	test("yields text events from content_block_delta (text_delta)", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		]);

		const events = await collect(parseAnthropicStream(stream, "claude-haiku-4.5", configDir));

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{
				type: "usage",
				tokenCount: 10,
				tokenLimit: 128000,
				display: "github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 10 / 128000 | 0%",
				outputTokens: 5,
				totalTokens: 15,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
			{ type: "finish", reason: "stop" },
		]);
	});

	test("yields tool_call_start and tool_call_delta events from tool_use blocks", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 20, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tc_1", name: "read_file" } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"foo.ts"}' } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
			{ type: "message_stop" },
		]);

		const events = await collect(parseAnthropicStream(stream, "claude-haiku-4.5", configDir));

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "tc_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 20,
				tokenLimit: 128000,
				display: "github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 20 / 128000 | 0%",
				outputTokens: 8,
				totalTokens: 28,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("handles mixed text and tool_use blocks in one message", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_3", usage: { input_tokens: 15, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me read that." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tc_2", name: "bash" } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
			{ type: "message_stop" },
		]);

		const events = await collect(parseAnthropicStream(stream, "claude-haiku-4.5", configDir));

		expect(events).toEqual([
			{ type: "text", text: "Let me read that." },
			{ type: "tool_call_start", index: 1, id: "tc_2", name: "bash" },
			{ type: "tool_call_delta", index: 1, arguments: '{"command":"ls"}' },
			{
				type: "usage",
				tokenCount: 15,
				tokenLimit: 128000,
				display: "github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 15 / 128000 | 0%",
				outputTokens: 12,
				totalTokens: 27,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("emits reasoning events from thinking blocks", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_5", usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm let me think" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		]);

		const events = await collect(parseAnthropicStream(stream, "claude-haiku-4.5", configDir));

		expect(events).toEqual([
			{ type: "reasoning_start", index: 0, reasoning: { kind: "text-summary", text: "" } },
			{ type: "reasoning_delta", index: 0, delta: { kind: "text", text: "hmm let me think" } },
			{ type: "reasoning_end", index: 0 },
			{ type: "text", text: "Answer" },
			{
				type: "usage",
				tokenCount: 10,
				tokenLimit: 128000,
				display: "github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 10 / 128000 | 0%",
				outputTokens: 3,
				totalTokens: 13,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
			{ type: "finish", reason: "stop" },
		]);
	});
});
