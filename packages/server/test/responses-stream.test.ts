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
		return parseResponsesSSE(mockSSEStream(frames), model, "user", configDir, { providerId: "opencode-zen" });
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
		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{
				type: "usage",
				tokenCount: 42,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | $1.00 | $4.00 | 42 / 272000 | 0%",
				outputTokens: 10,
				totalTokens: 52,
			},
			{ type: "finish", reason: "stop" },
		]);
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
		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":' },
			{ type: "tool_call_delta", index: 0, arguments: '"foo.ts"}' },
			{
				type: "usage",
				tokenCount: 20,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | $1.00 | $4.00 | 20 / 272000 | 0%",
				outputTokens: 5,
				totalTokens: 25,
			},
			{ type: "finish", reason: "tool_calls" },
		]);
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
		expect(events).toEqual([
			{ type: "text", text: "Let me help." },
			{ type: "tool_call_start", index: 0, id: "call_2", name: "bash" },
			{ type: "tool_call_delta", index: 0, arguments: '{"cmd":"ls"}' },
			{
				type: "usage",
				tokenCount: 30,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | $1.00 | $4.00 | 30 / 272000 | 0%",
				outputTokens: 8,
				totalTokens: 38,
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("reasoning items are silently skipped", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
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
		expect(events).toEqual([
			{ type: "text", text: "OK" },
			{
				type: "usage",
				tokenCount: 12,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | $1.00 | $4.00 | 12 / 272000 | 0%",
				outputTokens: 2,
				totalTokens: 14,
			},
			{ type: "finish", reason: "stop" },
		]);
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
		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_a", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path":"a"}' },
			{ type: "tool_call_start", index: 1, id: "call_b", name: "bash" },
			{ type: "tool_call_delta", index: 1, arguments: '{"command":"pwd"}' },
			{
				type: "usage",
				tokenCount: 50,
				tokenLimit: 272000,
				display: "opencode-zen | gpt-5.4 | $1.00 | $4.00 | 50 / 272000 | 0%",
				outputTokens: 6,
				totalTokens: 56,
			},
			{ type: "finish", reason: "tool_calls" },
		]);
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
		const events = await collect(parseResponsesSSE(broken, "gpt-5.4", "user", configDir, { providerId: "opencode-zen" }));
		expect(events).toEqual([{ type: "finish", reason: "stop" }]);
	});
});
