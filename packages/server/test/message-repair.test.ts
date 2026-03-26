import { describe, expect, test } from "bun:test";
import { repairMessageOrdering } from "../src/message-repair";
import type { Message } from "../src/provider/provider";

describe("repairMessageOrdering", () => {
	test("returns messages unchanged when ordering is correct", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
			},
			{ role: "tool", content: "file content", tool_call_id: "tc1" },
			{ role: "assistant", content: "Here it is" },
		];
		const { messages: result, repaired } = repairMessageOrdering(messages);
		expect(result).toEqual(messages);
		expect(repaired).toBe(false);
	});

	test("inserts synthetic tool_result for orphaned tool_use", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			// No tool result — loop was aborted mid-execution
			{ role: "user", content: "resume" },
		];
		const { messages: result, repaired } = repairMessageOrdering(messages);
		expect(repaired).toBe(true);
		// Should have inserted a synthetic tool result between assistant and user
		expect(result).toHaveLength(5);
		expect(result[3]).toEqual({
			role: "tool",
			content: "[Tool execution was interrupted]",
			tool_call_id: "tc1",
		});
		expect(result[4]).toEqual({ role: "user", content: "resume" });
	});

	test("inserts synthetic tool_results for multiple orphaned tool_calls in one assistant message", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "tc1", type: "function", function: { name: "read_file", arguments: "{}" } },
					{ id: "tc2", type: "function", function: { name: "bash", arguments: "{}" } },
				],
			},
			// Only tc1 got a result, tc2 was interrupted
			{ role: "tool", content: "file content", tool_call_id: "tc1" },
			{ role: "user", content: "resume" },
		];
		const { messages: result, repaired } = repairMessageOrdering(messages);
		expect(repaired).toBe(true);
		// tc2 should get a synthetic result after tc1's real result
		expect(result[4]).toEqual({
			role: "tool",
			content: "[Tool execution was interrupted]",
			tool_call_id: "tc2",
		});
		expect(result[5]).toEqual({ role: "user", content: "resume" });
	});

	test("reorders interleaved messages from concurrent loops", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			// Interleaved: another assistant message from a concurrent loop
			{ role: "assistant", content: "I found something" },
			// The tool result for tc1 appears after the interloper
			{ role: "tool", content: "bash output", tool_call_id: "tc1" },
			{ role: "user", content: "continue" },
		];
		const { messages: result, repaired } = repairMessageOrdering(messages);
		expect(repaired).toBe(true);
		// tool result for tc1 should come right after its assistant message
		expect(result[3]).toEqual({ role: "tool", content: "bash output", tool_call_id: "tc1" });
		// The interleaved assistant should come after the tool result
		expect(result[4]).toEqual({ role: "assistant", content: "I found something" });
	});
});
