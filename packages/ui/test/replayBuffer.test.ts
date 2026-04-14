import { describe, expect, test } from "bun:test";
import { replayBufferToMessages } from "../src/replayBuffer";

describe("replayBufferToMessages", () => {
	test("empty buffer produces empty messages", () => {
		expect(replayBufferToMessages([])).toEqual([]);
	});

	test("token events produce a single assistant message with one text part", () => {
		const events = [
			{ type: "token" as const, text: "Hello ", sessionId: "c1" },
			{ type: "token" as const, text: "world", sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("assistant");
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(1);
			expect(msgs[0].parts[0]).toEqual({ type: "text", content: "Hello world" });
		}
	});

	test("tool_call event creates a tool_call part", () => {
		const events = [{ type: "tool_call" as const, id: "tc1", output: "▸ read_file foo.ts", sessionId: "c1" }];
		const msgs = replayBufferToMessages(events);
		expect(msgs).toHaveLength(1);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(1);
			expect(msgs[0].parts[0]).toEqual({ type: "tool_call", id: "tc1", content: "▸ read_file foo.ts" });
		}
	});

	test("tool_result creates a tool_result part", () => {
		const events = [
			{ type: "tool_call" as const, id: "tc1", output: "▸ read_file foo.ts", sessionId: "c1" },
			{ type: "tool_result" as const, id: "tc1", output: "file contents", mergeable: true, sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(2);
			expect(msgs[0].parts[1]).toEqual({
				type: "tool_result",
				id: "tc1",
				content: "file contents",
				mergeable: true,
				summary: undefined,
			});
		}
	});

	test("interleaved text and tools produce correct part sequence", () => {
		const events = [
			{ type: "token" as const, text: "Let me check", sessionId: "c1" },
			{ type: "tool_call" as const, id: "tc1", output: "▸ bash ls", sessionId: "c1" },
			{ type: "tool_result" as const, id: "tc1", output: "file1\nfile2", mergeable: true, sessionId: "c1" },
			{ type: "token" as const, text: "Found 2 files", sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(4);
			expect(msgs[0].parts[0].type).toBe("text");
			expect(msgs[0].parts[1].type).toBe("tool_call");
			expect(msgs[0].parts[2].type).toBe("tool_result");
			expect(msgs[0].parts[3].type).toBe("text");
		}
	});

	test("non-message events (status, error) are ignored", () => {
		const events = [
			{ type: "status" as const, text: "thinking...", sessionId: "c1" },
			{ type: "token" as const, text: "hello", sessionId: "c1" },
			{ type: "error" as const, message: "oops", sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		expect(msgs).toHaveLength(1);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(1);
			expect(msgs[0].parts[0]).toEqual({ type: "text", content: "hello" });
		}
	});

	test("tool_result with null output", () => {
		const events = [
			{ type: "tool_call" as const, id: "tc1", output: "▸ write_file", sessionId: "c1" },
			{ type: "tool_result" as const, id: "tc1", output: null, mergeable: false, sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts[1]).toEqual({
				type: "tool_result",
				id: "tc1",
				content: null,
				mergeable: false,
				summary: undefined,
			});
		}
	});

	test("tool_result with summary", () => {
		const events = [
			{ type: "tool_call" as const, id: "tc1", output: "▸ task analysis", sessionId: "c1" },
			{
				type: "tool_result" as const,
				id: "tc1",
				output: "result",
				mergeable: false,
				summary: "Analyzed codebase",
				sessionId: "c1",
			},
		];
		const msgs = replayBufferToMessages(events);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts[1]).toEqual({
				type: "tool_result",
				id: "tc1",
				content: "result",
				mergeable: false,
				summary: "Analyzed codebase",
			});
		}
	});

	test("consecutive tokens are concatenated, not separate parts", () => {
		const events = [
			{ type: "token" as const, text: "a", sessionId: "c1" },
			{ type: "token" as const, text: "b", sessionId: "c1" },
			{ type: "token" as const, text: "c", sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		if (msgs[0].role === "assistant") {
			expect(msgs[0].parts).toHaveLength(1);
			expect(msgs[0].parts[0]).toEqual({ type: "text", content: "abc" });
		}
	});

	test("prompt_echo event creates a user message with a timestamp", () => {
		const events = [
			{ type: "prompt_echo" as const, text: "Explore the codebase and find all usages of X", sessionId: "c1" },
			{ type: "token" as const, text: "I'll look into that", sessionId: "c1" },
		];
		const msgs = replayBufferToMessages(events);
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe("user");
		if (msgs[0].role === "user") {
			expect(msgs[0].text).toBe("Explore the codebase and find all usages of X");
			expect(msgs[0].timestamp).toBeTruthy();
		}
		expect(msgs[1].role).toBe("assistant");
	});
});
