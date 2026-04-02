import { describe, expect, test } from "bun:test";
import { EVICTION_DISTANCE, evictOldTurns } from "../src/compaction/eviction";
import type { Message } from "../src/provider/provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a standard assistant message with one tool call. */
function assistantWithToolCall(toolCallId: string, toolName: string, args: string = "{}"): Message {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id: toolCallId, type: "function", function: { name: toolName, arguments: args } }],
	};
}

/** Build a tool result message. */
function toolResult(toolCallId: string, content: string): Message {
	return { role: "tool", content, tool_call_id: toolCallId };
}

/**
 * Number of user/assistant pairs needed to push earlier content beyond
 * EVICTION_DISTANCE. Each pair is 2 messages, so we need
 * ceil((EVICTION_DISTANCE + 1) / 2) pairs.
 */
const PAD_PAIRS = Math.ceil((EVICTION_DISTANCE + 1) / 2);

/**
 * Generate alternating user/assistant pairs to pad the conversation.
 * Uses {@link PAD_PAIRS} by default — enough to push earlier content
 * beyond EVICTION_DISTANCE.
 */
function padding(count: number = PAD_PAIRS): Message[] {
	const result: Message[] = [];
	for (let i = 0; i < count; i++) {
		result.push({ role: "user", content: `padding-user-${i}` });
		result.push({ role: "assistant", content: `padding-assistant-${i}` });
	}
	return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evictOldTurns", () => {
	test("returns same reference when all messages are within EVICTION_DISTANCE", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file contents"),
			{ role: "assistant", content: "Here you go" },
		];

		const result = evictOldTurns(messages);
		expect(result).toBe(messages); // same reference
	});

	test("system messages are always kept", () => {
		const sys1: Message = { role: "system", content: "system prompt" };
		const sys2: Message = { role: "system", content: "second system" };

		// Old turn with intermediate messages that will be evicted
		const oldTurn: Message[] = [
			{ role: "user", content: "old question" },
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			{ role: "assistant", content: "old answer" },
		];

		const messages: Message[] = [sys1, sys2, ...oldTurn, ...padding()];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);
		// Both system messages must be present
		expect(result.filter((m) => m.role === "system")).toEqual([sys1, sys2]);
	});

	test("old turn is collapsed to user prompt + final assistant text response", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const oldFinalAssistant: Message = { role: "assistant", content: "old answer" };

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			oldFinalAssistant,
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// The old turn should be collapsed: user prompt + final assistant text
		// The tool call and tool result in the middle should be evicted
		expect(result[0]).toBe(oldUser);
		expect(result[1]).toBe(oldFinalAssistant);

		// Padding should follow
		expect(result.length).toBe(2 + padding().length);
	});

	test("old turn with no final assistant text keeps only user prompt", () => {
		const oldUser: Message = { role: "user", content: "old question" };

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			// No final plain-text assistant — turn ends with a tool result
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Only the user prompt from the old turn survives
		expect(result[0]).toBe(oldUser);
		// Next message is the start of padding
		expect(result[1]).toEqual({ role: "user", content: "padding-user-0" });
		expect(result.length).toBe(1 + padding().length);
	});

	test("old turn with task tool-call pairs preserves them", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const taskToolResult: Message = { role: "tool", content: "task result", tool_call_id: "task1" };

		const messages: Message[] = [
			oldUser,
			// Non-task tool call that should be evicted
			assistantWithToolCall("rf1", "read_file"),
			toolResult("rf1", "file contents"),
			// Task tool call that should be preserved
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "task1", type: "function", function: { name: "task", arguments: '{"prompt":"do stuff"}' } }],
			},
			taskToolResult,
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Old turn: user + task assistant + task tool result (non-task pair evicted)
		expect(result[0]).toBe(oldUser);
		// The assistant message should be rebuilt with task calls preserved
		expect(result[1]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "task1", type: "function", function: { name: "task", arguments: '{"prompt":"do stuff"}' } }],
		});
		expect(result[2]).toBe(taskToolResult);
		// Then padding
		expect(result.length).toBe(3 + padding().length);
	});

	test("recent turns are untouched — all messages preserved", () => {
		// Put an old turn first (will be collapsed), then a recent turn
		const oldUser: Message = { role: "user", content: "old" };
		const recentUser: Message = { role: "user", content: "recent" };
		const recentAssistantTool = assistantWithToolCall("tc-recent", "read_file");
		const recentToolResult = toolResult("tc-recent", "recent file contents");
		const recentAssistantText: Message = { role: "assistant", content: "recent answer" };

		const pad = padding();

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc-old", "read_file"),
			toolResult("tc-old", "old file"),
			...pad,
			recentUser,
			recentAssistantTool,
			recentToolResult,
			recentAssistantText,
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Recent turn messages should all be present at the end, untouched (same refs)
		const recentStart = result.length - 4;
		expect(result[recentStart]).toBe(recentUser);
		expect(result[recentStart + 1]).toBe(recentAssistantTool);
		expect(result[recentStart + 2]).toBe(recentToolResult);
		expect(result[recentStart + 3]).toBe(recentAssistantText);
	});

	test("mixed: some turns evicted, some not", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const oldFinal: Message = { role: "assistant", content: "old answer" };

		const pad = padding();

		const recentUser: Message = { role: "user", content: "recent question" };
		const recentAssistant: Message = { role: "assistant", content: "recent answer" };

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			oldFinal,
			...pad,
			recentUser,
			recentAssistant,
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Old turn collapsed: user + final text
		expect(result[0]).toBe(oldUser);
		expect(result[1]).toBe(oldFinal);

		// Padding turns intact (they are recent enough given their position)
		// Recent turn intact
		expect(result[result.length - 2]).toBe(recentUser);
		expect(result[result.length - 1]).toBe(recentAssistant);

		// Middle tool call/result from old turn evicted
		expect(result.length).toBe(2 + pad.length + 2);
	});

	test("turn ending with assistant tool_call (not text) keeps only user prompt", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const finalAssistantWithTools = assistantWithToolCall("tc2", "write_file");

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			finalAssistantWithTools, // last message is assistant with tool_calls, no plain text
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Only the user prompt from the old turn
		expect(result[0]).toBe(oldUser);
		expect(result[1]).toEqual({ role: "user", content: "padding-user-0" });
		expect(result.length).toBe(1 + padding().length);
	});

	test("assistant with both content and tool_calls is not treated as final text", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const hybridAssistant: Message = {
			role: "assistant",
			content: "I will read the file",
			tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: "{}" } }],
		};

		const messages: Message[] = [
			oldUser,
			hybridAssistant, // has content AND tool_calls — NOT plain text
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// The hybrid assistant has tool_calls, so the `!a.tool_calls` check fails.
		// Only user prompt kept.
		expect(result[0]).toBe(oldUser);
		expect(result[1]).toEqual({ role: "user", content: "padding-user-0" });
		expect(result.length).toBe(1 + padding().length);
	});

	test("empty content assistant at end of turn is not kept", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const emptyAssistant: Message = { role: "assistant", content: "" };

		const messages: Message[] = [
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			emptyAssistant, // content is "", which is falsy
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// Empty content assistant is not kept (falsy check)
		expect(result[0]).toBe(oldUser);
		expect(result[1]).toEqual({ role: "user", content: "padding-user-0" });
		expect(result.length).toBe(1 + padding().length);
	});

	test("input array is not mutated", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const assistantTC = assistantWithToolCall("tc1", "read_file");
		const toolRes = toolResult("tc1", "file output");
		const finalAssistant: Message = { role: "assistant", content: "old answer" };
		const pad = padding();

		const messages: Message[] = [oldUser, assistantTC, toolRes, finalAssistant, ...pad];
		const originalLength = messages.length;
		const originalSnapshot = [...messages];

		evictOldTurns(messages);

		// Original array must not be changed
		expect(messages.length).toBe(originalLength);
		expect(messages).toEqual(originalSnapshot);
	});

	test("assistant with mixed task and non-task tool_calls strips non-task calls", () => {
		const oldUser: Message = { role: "user", content: "old question" };
		const mixedAssistant: Message = {
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "task1", type: "function", function: { name: "task", arguments: '{"prompt":"sub task"}' } },
				{ id: "rf1", type: "function", function: { name: "read_file", arguments: '{"path":"foo.ts"}' } },
			],
		};
		const taskResult: Message = { role: "tool", content: "task done", tool_call_id: "task1" };
		const readFileResult: Message = { role: "tool", content: "file contents", tool_call_id: "rf1" };

		const messages: Message[] = [oldUser, mixedAssistant, taskResult, readFileResult, ...padding()];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// User prompt kept
		expect(result[0]).toBe(oldUser);

		// Assistant should be rebuilt with only the task call
		expect(result[1]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "task1", type: "function", function: { name: "task", arguments: '{"prompt":"sub task"}' } }],
		});

		// Task tool result kept
		expect(result[2]).toBe(taskResult);

		// Non-task tool result (readFileResult) should be evicted
		const allToolCallIds = result.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id);
		expect(allToolCallIds).not.toContain("rf1");

		expect(result.length).toBe(3 + padding().length);
	});

	test("pre-turn messages (before first user) are always kept", () => {
		// Non-system, non-user messages before the first user prompt
		const preAssistant: Message = { role: "assistant", content: "I am ready to help" };
		const preToolCall = assistantWithToolCall("pre-tc", "init_tool");
		const preToolResult = toolResult("pre-tc", "initialized");

		const oldUser: Message = { role: "user", content: "old question" };

		const messages: Message[] = [
			preAssistant,
			preToolCall,
			preToolResult,
			oldUser,
			assistantWithToolCall("tc1", "read_file"),
			toolResult("tc1", "file output"),
			...padding(),
		];

		const result = evictOldTurns(messages);
		expect(result).not.toBe(messages);

		// All pre-turn messages should be preserved (same references)
		expect(result[0]).toBe(preAssistant);
		expect(result[1]).toBe(preToolCall);
		expect(result[2]).toBe(preToolResult);

		// Old turn user prompt is kept
		expect(result[3]).toBe(oldUser);
	});
});
