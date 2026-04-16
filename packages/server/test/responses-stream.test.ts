import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../src/provider/provider";

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

async function collectError(stream: AsyncGenerator<StreamEvent>): Promise<Error> {
	try {
		for await (const _event of stream) {
			/* drain */
		}
		throw new Error("Expected error but stream completed");
	} catch (e) {
		return e as Error;
	}
}

const FAKE_CONFIG_DIR = "/nonexistent-config-dir";

describe("parseResponsesSSE", () => {
	// Lazy import so the first test run fails with module-not-found
	async function parse(frames: { event: string; data: Record<string, unknown> }[], model = "test-model") {
		const { parseResponsesSSE } = await import("../src/provider/responses-stream");
		return parseResponsesSSE(mockSSEStream(frames), model, "user", FAKE_CONFIG_DIR);
	}

	test("text streaming yields text events then usage + finish(stop)", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message" },
				},
			},
			{
				event: "response.output_text.delta",
				data: {
					type: "response.output_text.delta",
					output_index: 0,
					delta: "Hello",
				},
			},
			{
				event: "response.output_text.delta",
				data: {
					type: "response.output_text.delta",
					output_index: 0,
					delta: " world",
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						usage: { input_tokens: 42, output_tokens: 10, total_tokens: 52 },
					},
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
				tokenLimit: 0,
				display: "test-model | ?x | 42 tokens",
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
					item: {
						type: "function_call",
						call_id: "call_1",
						name: "read_file",
					},
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: {
					type: "response.function_call_arguments.delta",
					output_index: 0,
					delta: '{"path":',
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: {
					type: "response.function_call_arguments.delta",
					output_index: 0,
					delta: '"foo.ts"}',
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_2",
						status: "completed",
						usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
					},
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
				tokenLimit: 0,
				display: "test-model | ?x | 20 tokens",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("mixed text and function_call → finish is tool_calls", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message" },
				},
			},
			{
				event: "response.output_text.delta",
				data: {
					type: "response.output_text.delta",
					output_index: 0,
					delta: "Let me help.",
				},
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "function_call",
						call_id: "call_2",
						name: "bash",
					},
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: {
					type: "response.function_call_arguments.delta",
					output_index: 1,
					delta: '{"cmd":"ls"}',
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_3",
						status: "completed",
						usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
					},
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
				tokenLimit: 0,
				display: "test-model | ?x | 30 tokens",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("reasoning items are silently skipped", async () => {
		const gen = await parse([
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning" },
				},
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "message" },
				},
			},
			{
				event: "response.output_text.delta",
				data: {
					type: "response.output_text.delta",
					output_index: 1,
					delta: "Answer",
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_4",
						status: "completed",
						usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
					},
				},
			},
		]);

		const events = await collect(gen);
		expect(events).toEqual([
			{ type: "text", text: "Answer" },
			{
				type: "usage",
				tokenCount: 15,
				tokenLimit: 0,
				display: "test-model | ?x | 15 tokens",
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
					output_index: 0,
					item: {
						type: "function_call",
						call_id: "call_a",
						name: "read_file",
					},
				},
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "function_call",
						call_id: "call_b",
						name: "bash",
					},
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: {
					type: "response.function_call_arguments.delta",
					output_index: 0,
					delta: '{"a":1}',
				},
			},
			{
				event: "response.function_call_arguments.delta",
				data: {
					type: "response.function_call_arguments.delta",
					output_index: 1,
					delta: '{"b":2}',
				},
			},
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						id: "resp_5",
						status: "completed",
						usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62 },
					},
				},
			},
		]);

		const events = await collect(gen);
		expect(events).toEqual([
			{
				type: "tool_call_start",
				index: 0,
				id: "call_a",
				name: "read_file",
			},
			{ type: "tool_call_start", index: 1, id: "call_b", name: "bash" },
			{ type: "tool_call_delta", index: 0, arguments: '{"a":1}' },
			{ type: "tool_call_delta", index: 1, arguments: '{"b":2}' },
			{
				type: "usage",
				tokenCount: 50,
				tokenLimit: 0,
				display: "test-model | ?x | 50 tokens",
			},
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("response.failed throws Error with code and message", async () => {
		const gen = await parse([
			{
				event: "response.failed",
				data: {
					type: "response.failed",
					response: {
						id: "resp_6",
						status: "failed",
						error: { code: "rate_limit", message: "Too many requests" },
					},
				},
			},
		]);

		const err = await collectError(gen);
		expect(err.message).toContain("rate_limit");
		expect(err.message).toContain("Too many requests");
	});
});
