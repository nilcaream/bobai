import { describe, expect, test } from "bun:test";
import { reconstructMessages } from "../src/messageReconstruction";

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
			expect(result[0].timestamp).toBe("2026-03-06 01:02:03");
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
