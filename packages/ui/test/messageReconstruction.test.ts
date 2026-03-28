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
			expect(toolResult?.content).toBe("$ `ls`\n```\nraw stdout\n```");
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
			expect(toolResult?.content).toBe("file contents here");
		}
	});

	test("preserves null content when ui_output is explicitly null (task tool)", () => {
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
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "task", arguments: '{"description":"Find CPU hog","prompt":"do it"}' },
						},
					],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "full subagent response text",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: {
					tool_call_id: "call_1",
					format_call: "**Subagent** Find CPU hog",
					ui_output: null,
					mergeable: false,
					tool_summary: "2026-03-06 20:28:32 | gpt-5-mini | agent: 3 | tokens: 6614 | 41.26s",
				},
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			// tool_call content should be overridden by format_call
			const toolCall = result[0].parts.find((p) => p.type === "tool_call");
			expect(toolCall?.content).toBe("**Subagent** Find CPU hog");
			// tool_result content should be null (not the raw subagent response)
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult?.content).toBeNull();
			expect(toolResult?.mergeable).toBe(false);
			// tool_summary should be passed through as summary on the part
			expect(toolResult?.summary).toBe("2026-03-06 20:28:32 | gpt-5-mini | agent: 3 | tokens: 6614 | 41.26s");
		}
	});

	test("format_call overrides generic tool_call content", () => {
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
					tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls -la"}' } }],
				},
			},
			{
				id: "3",
				sessionId: "s",
				role: "tool" as const,
				content: "file1.txt\nfile2.txt",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: {
					tool_call_id: "call_1",
					format_call: "`$ ls -la`",
					ui_output: "$ `ls -la`\n```\nfile1.txt\nfile2.txt\n```",
					mergeable: true,
				},
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolCall = result[0].parts.find((p) => p.type === "tool_call");
			// Should use format_call, not the generic "**bash** {\"command\":\"ls -la\"}"
			expect(toolCall?.content).toBe("`$ ls -la`");
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult?.content).toBe("$ `ls -la`\n```\nfile1.txt\nfile2.txt\n```");
		}
	});

	test("falls back to generic tool_call content when format_call absent (backward compat)", () => {
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
				content: "output",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1" },
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolCall = result[0].parts.find((p) => p.type === "tool_call");
			// No format_call → uses generic format
			expect(toolCall?.content).toBe('**bash** {"command":"ls"}');
		}
	});

	test("defaults mergeable to true when not in metadata (backward compat)", () => {
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
				content: "output",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1" },
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult?.mergeable).toBe(true);
		}
	});

	test("respects explicit mergeable: true in metadata", () => {
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
				content: "output",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: { tool_call_id: "call_1", ui_output: "$ `ls`\n```\noutput\n```", mergeable: true },
			},
		];
		const result = reconstructMessages(stored);
		if (result[0].role === "assistant") {
			const toolResult = result[0].parts.find((p) => p.type === "tool_result");
			expect(toolResult?.mergeable).toBe(true);
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

			// Timestamp from last assistant row (used for status bar on final panel)
			expect(result[1].timestamp).toBe(expectedLocalTimestamp("2026-03-06T01:00:05Z"));
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

	test("places text before tool_calls when assistant message has both", () => {
		// During streaming, the provider emits text tokens first, then tool_call events.
		// Reconstruction must match that order: [text, tool_call, tool_result].
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
				content: "check memory",
				createdAt: "2026-03-06T01:00:00Z",
				sortOrder: 1,
				metadata: null,
			},
			{
				id: "3",
				sessionId: "s",
				role: "assistant" as const,
				content: "I'll check the free memory on the system.",
				createdAt: "2026-03-06T01:00:01Z",
				sortOrder: 2,
				metadata: {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"free -h"}' } }],
				},
			},
			{
				id: "4",
				sessionId: "s",
				role: "tool" as const,
				content: "total: 16G used: 8G free: 8G",
				createdAt: "2026-03-06T01:00:02Z",
				sortOrder: 3,
				metadata: { tool_call_id: "call_1", format_call: "`$ free -h`" },
			},
			{
				id: "5",
				sessionId: "s",
				role: "assistant" as const,
				content: "You have 8G free.",
				createdAt: "2026-03-06T01:00:03Z",
				sortOrder: 4,
				metadata: { summary: "summary", turn_model: "gpt-4o" },
			},
		];
		const result = reconstructMessages(stored);
		expect(result).toHaveLength(2);
		if (result[1].role === "assistant") {
			// text → tool_call → tool_result → text (final response)
			expect(result[1].parts).toHaveLength(4);
			expect(result[1].parts[0].type).toBe("text");
			expect(result[1].parts[0].content).toBe("I'll check the free memory on the system.");
			expect(result[1].parts[1].type).toBe("tool_call");
			expect(result[1].parts[2].type).toBe("tool_result");
			expect(result[1].parts[3].type).toBe("text");
			expect(result[1].parts[3].content).toBe("You have 8G free.");
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
