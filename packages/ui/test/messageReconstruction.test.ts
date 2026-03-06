import { describe, expect, test } from "bun:test";
import { reconstructMessages } from "../src/messageReconstruction";

function expectedLocalTimestamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe("reconstructMessages", () => {
	test("skips system messages", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(0);
	});

	test("converts user messages", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "user" as const,
				content: "hello",
				createdAt: "2026-03-06T01:02:03Z",
				sortOrder: 1,
				metadata: null,
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
		if (result[0].role === "user") {
			expect(result[0].text).toBe("hello");
			expect(result[0].timestamp).toBe(expectedLocalTimestamp("2026-03-06T01:02:03Z"));
		}
	});

	test("converts assistant text messages", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "hello back",
				createdAt: "2026-03-06T01:02:03Z",
				sortOrder: 1,
				metadata: null,
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("assistant");
		if (result[0].role === "assistant") {
			expect(result[0].parts).toHaveLength(1);
			expect(result[0].parts[0].type).toBe("text");
			expect(result[0].parts[0].content).toBe("hello back");
		}
	});

	test("converts assistant tool_calls + tool results", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x.ts"}' } }],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "file contents here",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1" },
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(1);
		if (result[0].role === "assistant") {
			expect(result[0].parts).toHaveLength(2);
			expect(result[0].parts[0].type).toBe("tool_call");
			expect(result[0].parts[1].type).toBe("tool_result");
			if (result[0].parts[1].type === "tool_result") {
				expect(result[0].parts[1].content).toBe("file contents here");
			}
		}
	});

	test("prefers ui_output over raw content for tool results", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "raw stdout",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1", ui_output: "$ `ls`\n```\nraw stdout\n```" },
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(1);
		if (result[0].role === "assistant") {
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult).toBeDefined();
			expect(toolResult!.content).toBe("$ `ls`\n```\nraw stdout\n```");
		}
	});

	test("falls back to raw content when ui_output is absent", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x.ts"}' } }],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "file contents here",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1" },
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult!.content).toBe("file contents here");
		}
	});

	test("falls back to raw content when ui_output is null", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x.ts"}' } }],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "raw content fallback",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1", ui_output: null },
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult!.content).toBe("raw content fallback");
		}
	});

	test("restores summary and turn_model from assistant metadata", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "prompt",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "assistant" as const,
				content: "response text",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: { summary: "Model: gpt-4o | Cost: 1 PR | Tokens: 500", turn_model: "gpt-4o" },
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(1);
		if (result[0].role === "assistant") {
			expect(result[0].summary).toBe("Model: gpt-4o | Cost: 1 PR | Tokens: 500");
			expect(result[0].model).toBe("gpt-4o");
		}
	});

	test("merges multi-step agent turn into single assistant message", () => {
		// Simulates: assistant calls tool, gets result, calls another tool, gets result, then replies with text.
		// DB has 3 assistant rows + 2 tool rows — should produce 1 UI assistant message.
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "sys",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "user" as const,
				content: "read two files",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: null,
			},
			// First LLM call: tool_call
			{
				id: "3",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
				},
			},
			{
				id: "4",
				sessionId: "s",
				role: "tool" as const,
				content: "contents of a.ts",
				createdAt: "2026-03-06T01:00:02Z",
				sortOrder: 3,
				metadata: { tool_call_id: "call_1" },
			},
			// Second LLM call: another tool_call
			{
				id: "5",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:03Z",
				sortOrder: 4,
				metadata: {
					tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } }],
				},
			},
			{
				id: "6",
				sessionId: "s",
				role: "tool" as const,
				content: "contents of b.ts",
				createdAt: "2026-03-06T01:00:04Z",
				sortOrder: 5,
				metadata: { tool_call_id: "call_2" },
			},
			// Third LLM call: final text response with summary
			{
				id: "7",
				sessionId: "s",
				role: "assistant" as const,
				content: "Here are both files.",
				createdAt: "2026-03-06T01:00:05Z",
				sortOrder: 6,
				metadata: { summary: "Model: gpt-4o | Cost: 1 PR", turn_model: "gpt-4o" },
			},
		];
		const result = reconstructMessages(stored);
		// Should be: 1 user + 1 assistant (merged)
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");

		if (result[1].role === "assistant") {
			// 2 tool_calls + 2 tool_results + 1 text = 5 parts
			expect(result[1].parts).toHaveLength(5);
			expect(result[1].parts[0].type).toBe("tool_call");
			expect(result[1].parts[1].type).toBe("tool_result");
			expect(result[1].parts[2].type).toBe("tool_call");
			expect(result[1].parts[3].type).toBe("tool_result");
			expect(result[1].parts[4].type).toBe("text");
			expect(result[1].parts[4].content).toBe("Here are both files.");

			// Timestamp from first assistant row
			expect(result[1].timestamp).toBe(expectedLocalTimestamp("2026-03-06T01:00:01Z"));
			// Summary/model from last assistant row
			expect(result[1].summary).toBe("Model: gpt-4o | Cost: 1 PR");
			expect(result[1].model).toBe("gpt-4o");
		}
	});

	test("separate turns stay separate after user message boundary", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "sys",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			// Turn 1
			{
				id: "2",
				sessionId: "s",
				role: "user" as const,
				content: "first question",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: null,
			},
			{
				id: "3",
				sessionId: "s",
				role: "assistant" as const,
				content: "",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
				},
			},
			{
				id: "4",
				sessionId: "s",
				role: "tool" as const,
				content: "output",
				createdAt: "2026-03-06T01:00:02Z",
				sortOrder: 3,
				metadata: { tool_call_id: "call_1" },
			},
			{
				id: "5",
				sessionId: "s",
				role: "assistant" as const,
				content: "done",
				createdAt: "2026-03-06T01:00:03Z",
				sortOrder: 4,
				metadata: { summary: "Turn 1 summary", turn_model: "gpt-4o" },
			},
			// Turn 2
			{
				id: "6",
				sessionId: "s",
				role: "user" as const,
				content: "second question",
				createdAt: "2026-03-06T02:00:00Z",
				sortOrder: 5,
				metadata: null,
			},
			{
				id: "7",
				sessionId: "s",
				role: "assistant" as const,
				content: "simple answer",
				createdAt: "2026-03-06T02:00:01Z",
				sortOrder: 6,
				metadata: { summary: "Turn 2 summary", turn_model: "gpt-4o" },
			},
		];
		const result = reconstructMessages(stored);
		// user, assistant (merged), user, assistant
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[2].role).toBe("user");
		expect(result[3].role).toBe("assistant");

		if (result[1].role === "assistant") {
			// 1 tool_call + 1 tool_result + 1 text = 3 parts
			expect(result[1].parts).toHaveLength(3);
			expect(result[1].summary).toBe("Turn 1 summary");
		}

		if (result[3].role === "assistant") {
			expect(result[3].parts).toHaveLength(1);
			expect(result[3].summary).toBe("Turn 2 summary");
		}
	});

	test("handles mixed text and tool calls in sequence", () => {
		const stored = [
			{
				id: "1",
				sessionId: "s",
				role: "system" as const,
				content: "sys",
				createdAt: "2026-03-06T00:00:00Z",
				sortOrder: 0,
				metadata: null,
			},
			{
				id: "2",
				sessionId: "s",
				role: "user" as const,
				content: "do something",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: null,
			},
			{
				id: "3",
				sessionId: "s",
				role: "assistant" as const,
				content: "thinking...",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: null,
			},
			{
				id: "4",
				sessionId: "s",
				role: "user" as const,
				content: "another question",
				createdAt: "2026-03-06T02:00:00Z",
				sortOrder: 3,
				metadata: null,
			},
			{
				id: "5",
				sessionId: "s",
				role: "assistant" as const,
				content: "answer",
				createdAt: "2026-03-06T02:00:01Z",
				sortOrder: 4,
				metadata: null,
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[2].role).toBe("user");
		expect(result[3].role).toBe("assistant");
	});
});
