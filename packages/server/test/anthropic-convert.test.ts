import { describe, expect, test } from "bun:test";
import { convertMessagesToAnthropic, convertToolsToAnthropic } from "../src/provider/anthropic-convert";
import type { Message, ToolDefinition } from "../src/provider/provider";

describe("convertMessagesToAnthropic", () => {
	test("extracts system message and converts user/assistant", () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.system).toBe("You are helpful.");
		expect(result.messages).toEqual([
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
		]);
	});

	test("handles assistant with tool_calls (content: null)", () => {
		const messages: Message[] = [
			{ role: "user", content: "Read the file" },
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
		const result = convertMessagesToAnthropic(messages);
		expect(result.system).toBeUndefined();
		expect(result.messages).toEqual([
			{ role: "user", content: "Read the file" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tc1",
						name: "read_file",
						input: { path: "foo.ts" },
					},
				],
			},
		]);
	});

	test("handles assistant with text AND tool_calls", () => {
		const messages: Message[] = [
			{ role: "user", content: "Do stuff" },
			{
				role: "assistant",
				content: "Let me read that file.",
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"x.ts"}' },
					},
				],
			},
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.messages).toEqual([
			{ role: "user", content: "Do stuff" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me read that file." },
					{
						type: "tool_use",
						id: "tc1",
						name: "read_file",
						input: { path: "x.ts" },
					},
				],
			},
		]);
	});

	test("converts tool results into user messages with tool_result blocks", () => {
		const messages: Message[] = [
			{ role: "user", content: "Read it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.ts"}' },
					},
				],
			},
			{ role: "tool", content: "file contents here", tool_call_id: "tc1" },
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tc1",
					content: "file contents here",
				},
			],
		});
	});

	test("groups consecutive tool results into a single user message", () => {
		const messages: Message[] = [
			{ role: "user", content: "Do both" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.ts"}' },
					},
					{
						id: "tc2",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls"}' },
					},
				],
			},
			{ role: "tool", content: "contents of a.ts", tool_call_id: "tc1" },
			{ role: "tool", content: "file1\nfile2", tool_call_id: "tc2" },
		];
		const result = convertMessagesToAnthropic(messages);
		// assistant + grouped tool results = 3 messages total
		expect(result.messages).toHaveLength(3);
		expect(result.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tc1",
					content: "contents of a.ts",
				},
				{
					type: "tool_result",
					tool_use_id: "tc2",
					content: "file1\nfile2",
				},
			],
		});
	});

	test("handles no system message", () => {
		const messages: Message[] = [
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello" },
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.system).toBeUndefined();
		expect(result.messages).toHaveLength(2);
	});

	test("handles multiple system messages by concatenating", () => {
		const messages: Message[] = [
			{ role: "system", content: "Rule one." },
			{ role: "system", content: "Rule two." },
			{ role: "user", content: "Hi" },
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.system).toBe("Rule one.\n\nRule two.");
		expect(result.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	test("handles assistant with empty content ('') and tool_calls — no text block", () => {
		const messages: Message[] = [
			{ role: "user", content: "Go" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"echo hi"}' },
					},
				],
			},
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.messages[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tc1",
					name: "bash",
					input: { command: "echo hi" },
				},
			],
		});
	});

	test("wraps unparseable tool_call arguments in _raw", () => {
		const messages: Message[] = [
			{ role: "user", content: "Go" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "bash", arguments: "not json" },
					},
				],
			},
		];
		const result = convertMessagesToAnthropic(messages);
		expect(result.messages[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tc1",
					name: "bash",
					input: { _raw: "not json" },
				},
			],
		});
	});
});

describe("convertToolsToAnthropic", () => {
	test("converts OpenAI function tools to Anthropic format", () => {
		const tools: ToolDefinition[] = [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file from disk",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "File path" },
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "bash",
					description: "Run a shell command",
					parameters: {
						type: "object",
						properties: {
							command: { type: "string", description: "The command" },
						},
						required: ["command"],
					},
				},
			},
		];
		const result = convertToolsToAnthropic(tools);
		expect(result).toEqual([
			{
				name: "read_file",
				description: "Read a file from disk",
				input_schema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path" },
					},
					required: ["path"],
				},
			},
			{
				name: "bash",
				description: "Run a shell command",
				input_schema: {
					type: "object",
					properties: {
						command: { type: "string", description: "The command" },
					},
					required: ["command"],
				},
			},
		]);
	});

	test("returns empty array for empty tools", () => {
		expect(convertToolsToAnthropic([])).toEqual([]);
	});
});
