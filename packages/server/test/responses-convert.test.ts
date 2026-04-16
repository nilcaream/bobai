import { describe, expect, test } from "bun:test";
import type { Message, ToolDefinition } from "../src/provider/provider";
import { convertMessagesToResponses, convertToolsToResponses } from "../src/provider/responses-convert";

describe("convertMessagesToResponses", () => {
	test("converts single system message to developer role", () => {
		const messages: Message[] = [{ role: "system", content: "You are helpful." }];
		expect(convertMessagesToResponses(messages)).toEqual([{ role: "developer", content: "You are helpful." }]);
	});

	test("concatenates multiple system messages into one developer message", () => {
		const messages: Message[] = [
			{ role: "system", content: "Rule 1" },
			{ role: "user", content: "Hi" },
			{ role: "system", content: "Rule 2" },
		];
		const result = convertMessagesToResponses(messages);
		expect(result[0]).toEqual({ role: "developer", content: "Rule 1\n\nRule 2" });
		expect(result[1]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "Hi" }],
		});
	});

	test("converts user message to input_text block", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		expect(convertMessagesToResponses(messages)).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
	});

	test("converts assistant text-only to output message", () => {
		const messages: Message[] = [{ role: "assistant", content: "Hi there!" }];
		expect(convertMessagesToResponses(messages)).toEqual([
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Hi there!" }],
				status: "completed",
			},
		]);
	});

	test("converts assistant with tool_calls to function_call items", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
					},
				],
			},
		];
		expect(convertMessagesToResponses(messages)).toEqual([
			{
				type: "function_call",
				call_id: "tc1",
				name: "read_file",
				arguments: '{"path":"foo.ts"}',
			},
		]);
	});

	test("converts assistant with text AND tool_calls to message + function_call items", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: "Let me read that file.",
				tool_calls: [
					{
						id: "tc2",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"bar.ts"}' },
					},
				],
			},
		];
		const result = convertMessagesToResponses(messages);
		expect(result).toEqual([
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Let me read that file." }],
				status: "completed",
			},
			{
				type: "function_call",
				call_id: "tc2",
				name: "read_file",
				arguments: '{"path":"bar.ts"}',
			},
		]);
	});

	test("does not emit message item when assistant content is null", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }],
			},
		];
		const result = convertMessagesToResponses(messages);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty("type", "function_call");
	});

	test("does not emit message item when assistant content is empty string", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }],
			},
		];
		const result = convertMessagesToResponses(messages);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty("type", "function_call");
	});

	test("converts tool results to function_call_output", () => {
		const messages: Message[] = [{ role: "tool", content: "file contents here", tool_call_id: "tc1" }];
		expect(convertMessagesToResponses(messages)).toEqual([
			{ type: "function_call_output", call_id: "tc1", output: "file contents here" },
		]);
	});

	test("handles multiple tool calls and results", () => {
		const messages: Message[] = [
			{ role: "user", content: "Read two files" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
					{ id: "tc2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
				],
			},
			{ role: "tool", content: "content a", tool_call_id: "tc1" },
			{ role: "tool", content: "content b", tool_call_id: "tc2" },
		];
		const result = convertMessagesToResponses(messages);
		expect(result).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Read two files" }] },
			{ type: "function_call", call_id: "tc1", name: "read_file", arguments: '{"path":"a.ts"}' },
			{ type: "function_call", call_id: "tc2", name: "read_file", arguments: '{"path":"b.ts"}' },
			{ type: "function_call_output", call_id: "tc1", output: "content a" },
			{ type: "function_call_output", call_id: "tc2", output: "content b" },
		]);
	});

	test("full conversation with system, user, assistant, tools", () => {
		const messages: Message[] = [
			{ role: "system", content: "Be helpful." },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi!" },
			{ role: "user", content: "Read foo" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"foo"}' } }],
			},
			{ role: "tool", content: "foo content", tool_call_id: "tc1" },
			{ role: "assistant", content: "Here is foo content." },
		];
		const result = convertMessagesToResponses(messages);
		expect(result).toHaveLength(7);
		expect(result[0]).toEqual({ role: "developer", content: "Be helpful." });
	});
});

describe("convertToolsToResponses", () => {
	test("converts tool definitions to responses format", () => {
		const tools: ToolDefinition[] = [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			},
		];
		expect(convertToolsToResponses(tools)).toEqual([
			{
				type: "function",
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				strict: false,
			},
		]);
	});

	test("converts multiple tools", () => {
		const tools: ToolDefinition[] = [
			{ type: "function", function: { name: "a", description: "A", parameters: {} } },
			{ type: "function", function: { name: "b", description: "B", parameters: {} } },
		];
		const result = convertToolsToResponses(tools);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("a");
		expect(result[1].name).toBe("b");
	});
});
