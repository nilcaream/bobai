import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { StreamEvent } from "../src/provider/provider";
import { createProviderModelsTempDir } from "./test-provider-models";

function mockSSEStream(frames: { event: string; data: Record<string, unknown> }[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
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

describe("parseResponsesSSE", () => {
	async function parse(frames: { event: string; data: Record<string, unknown> }[], model = "gpt-5.4") {
		const { parseResponsesSSE } = await import("../src/provider/responses-stream");
		return parseResponsesSSE(mockSSEStream(frames), model, configDir, { providerId: "opencode-zen" });
	}

	test("text streaming yields text events then usage + finish(stop)", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
			},
			{ event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "Hello" } },
			{ event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: " world" } },
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: { input_tokens: 42, output_tokens: 10, total_tokens: 52 } },
				},
			},
		]);

		const events = await collect(gen);
		expect(events[0]).toEqual({ type: "text", text: "Hello" });
		expect(events[1]).toEqual({ type: "text", text: " world" });
		expect(events[2]).toMatchObject({
			type: "usage",
			tokenCount: 42,
			tokenLimit: 272000,
			outputTokens: 10,
			totalTokens: 52,
		});
		if (events[2]?.type === "usage") {
			expect(events[2].display).toContain("gpt-5.4");
		}
		expect(events[3]).toEqual({ type: "finish", reason: "stop" });
	});

	test("tool calls yield tool_call_start + tool_call_delta then finish(tool_calls)", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", call_id: "call_1", name: "read_file" },
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 0, delta: '"foo.ts"}' },
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_2", status: "completed", usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
				},
			},
		]);

		const events = await collect(gen);
		expect(events[0]).toEqual({ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" });
		expect(events[1]).toEqual({ type: "tool_call_delta", index: 0, arguments: '{"path":' });
		expect(events[2]).toEqual({ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' });
		expect(events[3]).toMatchObject({
			type: "usage",
			tokenCount: 20,
			tokenLimit: 272000,
			outputTokens: 5,
			totalTokens: 25,
		});
		expect(events[4]).toEqual({ type: "finish", reason: "tool_calls" });
	});

	test("mixed text and function_call → finish is tool_calls", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
			},
			{
				event: "response.output_text.delta",
				data: { type: "response.output_text.delta", output_index: 0, delta: "Let me help." },
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", call_id: "call_2", name: "bash" },
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"cmd":"ls"}' },
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_3", status: "completed", usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } },
				},
			},
		]);

		const events = await collect(gen);
		expect(events[0]).toEqual({ type: "text", text: "Let me help." });
		expect(events[1]).toEqual({ type: "tool_call_start", index: 0, id: "call_2", name: "bash" });
		expect(events[2]).toEqual({ type: "tool_call_delta", index: 0, arguments: '{"cmd":"ls"}' });
		expect(events[3]).toMatchObject({
			type: "usage",
			tokenCount: 30,
			tokenLimit: 272000,
			outputTokens: 8,
			totalTokens: 38,
		});
		expect(events[4]).toEqual({ type: "finish", reason: "tool_calls" });
	});

	test("reasoning items emit reasoning events and capture summary + encrypted content", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			},
			{
				event: "response.reasoning_summary_text.delta",
				data: { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking..." },
			},
			{
				event: "response.output_item.done",
				data: {
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "rs_1",
						summary: [{ type: "summary_text", text: "Thinking... done" }],
						encrypted_content: "enc_123",
					},
				},
			},
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 1, item: { type: "message" } },
			},
			{ event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 1, delta: "OK" } },
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_4", status: "completed", usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 } },
				},
			},
		]);

		const events = await collect(gen);
		expect(events[0]).toEqual({ type: "reasoning_start", index: 0, reasoning: { kind: "responses-item", id: "rs_1" } });
		expect(events[1]).toEqual({ type: "reasoning_delta", index: 0, delta: { kind: "summary", summary: "Thinking..." } });
		expect(events[2]).toEqual({
			type: "reasoning_end",
			index: 0,
			reasoning: { kind: "responses-item", id: "rs_1", summary: "Thinking... done", encryptedContent: "enc_123" },
		});
		expect(events[3]).toEqual({ type: "text", text: "OK" });
		expect(events[4]).toMatchObject({
			type: "usage",
			tokenCount: 12,
			tokenLimit: 272000,
			outputTokens: 2,
			totalTokens: 14,
		});
		expect(events[5]).toEqual({ type: "finish", reason: "stop" });
	});

	test("multiple function_calls get sequential indices", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 2,
					item: { type: "function_call", call_id: "call_a", name: "read_file" },
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":"a"}' },
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 5,
					item: { type: "function_call", call_id: "call_b", name: "bash" },
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 5, delta: '{"command":"pwd"}' },
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_5", status: "completed", usage: { input_tokens: 50, output_tokens: 6, total_tokens: 56 } },
				},
			},
		]);
		const events = await collect(gen);
		expect(events[0]).toEqual({ type: "tool_call_start", index: 0, id: "call_a", name: "read_file" });
		expect(events[1]).toEqual({ type: "tool_call_delta", index: 0, arguments: '{"path":"a"}' });
		expect(events[2]).toEqual({ type: "tool_call_start", index: 1, id: "call_b", name: "bash" });
		expect(events[3]).toEqual({ type: "tool_call_delta", index: 1, arguments: '{"command":"pwd"}' });
		expect(events[4]).toMatchObject({
			type: "usage",
			tokenCount: 50,
			tokenLimit: 272000,
			outputTokens: 6,
			totalTokens: 56,
		});
		expect(events[5]).toEqual({ type: "finish", reason: "tool_calls" });
	});

	test("ignores unmapped output indexes instead of corrupting earlier items", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 3,
					item: { type: "function_call", call_id: "call_1", name: "read_file" },
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: { type: "response.function_call_arguments.delta", output_index: 99, delta: '{"path":"wrong"}' },
			},
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 4, item: { type: "reasoning", id: "rs_1" } },
			},
			{
				event: "response.reasoning_summary_text.delta",
				data: { type: "response.reasoning_summary_text.delta", output_index: 98, delta: "wrong" },
			},
			{
				event: "response.output_item.done",
				data: {
					type: "response.output_item.done",
					output_index: 4,
					item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "ok" }] },
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: { id: "resp_6", status: "completed", usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
				},
			},
		]);
		const events = await collect(gen);
		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "reasoning_start", index: 0, reasoning: { kind: "responses-item", id: "rs_1" } },
			{ type: "reasoning_end", index: 0, reasoning: { kind: "responses-item", id: "rs_1", summary: "ok" } },
			expect.objectContaining({ type: "usage", tokenCount: 9, outputTokens: 1, totalTokens: 10 }),
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("response.failed surfaces provider failure details", async () => {
		const gen = await parse([
			{
				event: "response.failed",
				data: {
					type: "response.failed",
					response: { error: { code: "boom", message: "broken" } },
				},
			},
		]);
		await expect(async () => {
			await collect(gen);
		}).toThrow("boom: broken");
	});

	test("top-level error event surfaces provider error details", async () => {
		const gen = await parse([
			{
				event: "error",
				data: { type: "error", code: "bad_request", message: "invalid input" },
			},
		]);
		await expect(async () => {
			await collect(gen);
		}).toThrow("bad_request: invalid input");
	});

	test("invalid JSON line is ignored and stream finishes cleanly", async () => {
		const encoder = new TextEncoder();
		const broken = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("event: response.completed\ndata: {not-json}\n\n"));
				controller.close();
			},
		});
		const { parseResponsesSSE } = await import("../src/provider/responses-stream");
		const events = await collect(parseResponsesSSE(broken, "gpt-5.4", configDir, { providerId: "opencode-zen" }));
		expect(events).toEqual([{ type: "finish", reason: "stop" }]);
	});
});
