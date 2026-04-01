import { describe, expect, test } from "bun:test";
import { parseAnthropicStream } from "../src/provider/anthropic-stream";
import type { StreamEvent } from "../src/provider/provider";

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

// configDir points to a nonexistent dir so loadModelsConfig returns []
// and formatModelDisplay falls back to "model | ?x | N tokens"
const FAKE_CONFIG_DIR = "/nonexistent-config-dir";

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

		const events = await collect(parseAnthropicStream(stream, "test-model", "user", FAKE_CONFIG_DIR));

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{ type: "usage", tokenCount: 10, tokenLimit: 0, display: "test-model | ?x | 10 tokens" },
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

		const events = await collect(parseAnthropicStream(stream, "test-model", "user", FAKE_CONFIG_DIR));

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "tc_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{ type: "usage", tokenCount: 20, tokenLimit: 0, display: "test-model | ?x | 20 tokens" },
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("handles mixed text and tool_use blocks in one message", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_3", usage: { input_tokens: 15, output_tokens: 0 } } },
			// Text block
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me read that." } },
			{ type: "content_block_stop", index: 0 },
			// Tool use block
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tc_2", name: "bash" } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
			{ type: "message_stop" },
		]);

		const events = await collect(parseAnthropicStream(stream, "test-model", "agent", FAKE_CONFIG_DIR));

		expect(events).toEqual([
			{ type: "text", text: "Let me read that." },
			{ type: "tool_call_start", index: 1, id: "tc_2", name: "bash" },
			{ type: "tool_call_delta", index: 1, arguments: '{"command":"ls"}' },
			{ type: "usage", tokenCount: 15, tokenLimit: 0, display: "test-model | ?x | 15 tokens" },
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("maps stop reasons correctly (end_turn → stop, tool_use → tool_calls, max_tokens → stop)", async () => {
		async function getFinishReason(stopReason: string): Promise<string> {
			const stream = mockAnthropicEvents([
				{ type: "message_start", message: { id: "msg_x", usage: { input_tokens: 5, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]);
			const events = await collect(parseAnthropicStream(stream, "test-model", "user", FAKE_CONFIG_DIR));
			const finish = events.find((e) => e.type === "finish");
			return (finish as { reason: string }).reason;
		}

		expect(await getFinishReason("end_turn")).toBe("stop");
		expect(await getFinishReason("tool_use")).toBe("tool_calls");
		expect(await getFinishReason("max_tokens")).toBe("stop");
	});

	test("emits finish even if stream ends without message_stop", async () => {
		const stream = mockAnthropicEvents([
			{ type: "message_start", message: { id: "msg_4", usage: { input_tokens: 7, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated" } },
			// No message_delta, no message_stop — stream ends abruptly
		]);

		const events = await collect(parseAnthropicStream(stream, "test-model", "user", FAKE_CONFIG_DIR));

		expect(events).toEqual([
			{ type: "text", text: "truncated" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("ignores thinking_delta events", async () => {
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

		const events = await collect(parseAnthropicStream(stream, "test-model", "user", FAKE_CONFIG_DIR));

		expect(events).toEqual([
			{ type: "text", text: "Answer" },
			{ type: "usage", tokenCount: 10, tokenLimit: 0, display: "test-model | ?x | 10 tokens" },
			{ type: "finish", reason: "stop" },
		]);
	});
});
