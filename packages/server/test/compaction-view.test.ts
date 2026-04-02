import { describe, expect, test } from "bun:test";
import { mapEvictedToStored } from "../src/compaction/view";
import type { Message } from "../src/provider/provider";
import type { StoredMessage } from "../src/session/repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function stored(role: StoredMessage["role"], content: string, metadata: Record<string, unknown> | null = null): StoredMessage {
	idCounter++;
	return {
		id: `msg-${idCounter}`,
		sessionId: "sess-1",
		role,
		content,
		createdAt: `2026-01-01T00:00:${String(idCounter).padStart(2, "0")}Z`,
		sortOrder: idCounter,
		metadata,
	};
}

function systemMsg(content: string): Message {
	return { role: "system", content };
}

function userMsg(content: string): Message {
	return { role: "user", content };
}

function assistantMsg(content: string): Message {
	return { role: "assistant", content, tool_calls: undefined };
}

function toolMsg(content: string, toolCallId: string): Message {
	return { role: "tool", content, tool_call_id: toolCallId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapEvictedToStored", () => {
	test("maps messages back by reference when no eviction occurred (compacted === evicted)", () => {
		const s1 = stored("user", "hello");
		const s2 = stored("assistant", "hi there");

		const sys: Message = systemMsg("system prompt");
		const u: Message = userMsg("hello");
		const a: Message = assistantMsg("hi there");
		const compacted = [sys, u, a];
		// No eviction — same array
		const evicted = compacted;

		const result = mapEvictedToStored(compacted, evicted, [s1, s2], "sess-1");

		expect(result).toHaveLength(3);
		// System message gets synthetic entry
		expect(result[0].id).toBe("system-dynamic");
		expect(result[0].role).toBe("system");
		// User and assistant should map to their original StoredMessages
		expect(result[1].id).toBe(s1.id);
		expect(result[1].createdAt).toBe(s1.createdAt);
		expect(result[1].content).toBe("hello");
		expect(result[2].id).toBe(s2.id);
		expect(result[2].createdAt).toBe(s2.createdAt);
		expect(result[2].content).toBe("hi there");
	});

	test("maps tool messages by tool_call_id, not by position", () => {
		const s1 = stored("assistant", "", {
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		});
		const s2 = stored("tool", "original output", { tool_call_id: "tc1" });

		const aMsg: Message = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		};
		const tMsg: Message = toolMsg("compacted output", "tc1");
		const compacted = [systemMsg("sys"), aMsg, tMsg];
		const evicted = compacted;

		const result = mapEvictedToStored(compacted, evicted, [s1, s2], "sess-1");

		// Tool message should have original stored ID but compacted content
		expect(result[2].id).toBe(s2.id);
		expect(result[2].content).toBe("compacted output");
		expect((result[2].metadata as Record<string, unknown>).tool_call_id).toBe("tc1");
	});

	test("correctly maps messages after eviction removes messages from the front", () => {
		// Simulate: 5 conversation messages, eviction removes messages at indices 1-2
		// (an old turn's tool call + result)
		const sUser = stored("user", "old question");
		const sAssistantTc = stored("assistant", "", {
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		});
		const sTool = stored("tool", "tool output", { tool_call_id: "tc1" });
		const sRecentUser = stored("user", "recent question");
		const sRecentAssistant = stored("assistant", "recent answer");

		const sys: Message = systemMsg("sys");
		const oldUser: Message = userMsg("old question");
		const oldAssistantTc: Message = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		};
		const oldTool: Message = toolMsg("tool output", "tc1");
		const recentUser: Message = userMsg("recent question");
		const recentAssistant: Message = assistantMsg("recent answer");

		const compacted = [sys, oldUser, oldAssistantTc, oldTool, recentUser, recentAssistant];
		const conversationMessages = [sUser, sAssistantTc, sTool, sRecentUser, sRecentAssistant];

		// Eviction kept: sys, oldUser (index 1), recentUser (index 4), recentAssistant (index 5)
		// Removed: oldAssistantTc (index 2), oldTool (index 3)
		const evicted = [sys, oldUser, recentUser, recentAssistant];

		const result = mapEvictedToStored(compacted, evicted, conversationMessages, "sess-1");

		expect(result).toHaveLength(4);
		// System
		expect(result[0].id).toBe("system-dynamic");
		// Old user — maps to sUser by reference
		expect(result[1].id).toBe(sUser.id);
		expect(result[1].content).toBe("old question");
		// Recent user — maps to sRecentUser by reference (NOT sAssistantTc which would be at i-1=1)
		expect(result[2].id).toBe(sRecentUser.id);
		expect(result[2].content).toBe("recent question");
		expect(result[2].createdAt).toBe(sRecentUser.createdAt);
		// Recent assistant — maps to sRecentAssistant
		expect(result[3].id).toBe(sRecentAssistant.id);
		expect(result[3].content).toBe("recent answer");
	});

	test("rebuilt assistant messages (from eviction filtering) get synthetic fallback", () => {
		// Eviction rebuilds assistant messages when stripping non-task tool_calls.
		// The rebuilt object is a new reference, not in the storedByRef map.
		const sUser = stored("user", "old question");
		const sAssistant = stored("assistant", "", {
			tool_calls: [
				{ id: "tc-task", type: "function", function: { name: "task", arguments: "{}" } },
				{ id: "tc-bash", type: "function", function: { name: "bash", arguments: "{}" } },
			],
		});

		const sys: Message = systemMsg("sys");
		const u: Message = userMsg("old question");
		const originalAssistant: Message = {
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "tc-task", type: "function", function: { name: "task", arguments: "{}" } },
				{ id: "tc-bash", type: "function", function: { name: "bash", arguments: "{}" } },
			],
		};

		const compacted = [sys, u, originalAssistant];

		// Eviction rebuilt this assistant — new object with only the task tool_call
		const rebuiltAssistant: Message = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "tc-task", type: "function", function: { name: "task", arguments: "{}" } }],
		};
		const evicted = [sys, u, rebuiltAssistant];

		const result = mapEvictedToStored(compacted, evicted, [sUser, sAssistant], "sess-1");

		expect(result).toHaveLength(3);
		// User maps correctly by reference
		expect(result[1].id).toBe(sUser.id);
		// Rebuilt assistant gets synthetic fallback (not the original sAssistant)
		expect(result[2].id).toBe("evicted-2");
		expect(result[2].role).toBe("assistant");
	});

	test("compacted content overrides original StoredMessage content", () => {
		const s1 = stored("tool", "very long original output", { tool_call_id: "tc1" });

		const sys: Message = systemMsg("sys");
		// Compaction shortened the tool output
		const compactedTool: Message = toolMsg("# COMPACTED: 500 lines removed", "tc1");
		const compacted = [sys, compactedTool];
		const evicted = compacted;

		const result = mapEvictedToStored(compacted, evicted, [s1], "sess-1");

		// Should have original's id/createdAt but compacted content
		expect(result[1].id).toBe(s1.id);
		expect(result[1].content).toBe("# COMPACTED: 500 lines removed");
	});

	test("positional mapping would fail but reference mapping succeeds", () => {
		// This is the exact bug scenario: eviction removes 2 messages from front,
		// so positional i-1 indexing would map evicted[2] to conversationMessages[1]
		// (wrong), but reference mapping correctly maps it to conversationMessages[3].
		const s0 = stored("user", "old user");
		const s1 = stored("assistant", "old tool call", {
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		});
		const s2 = stored("tool", "old tool output", { tool_call_id: "tc1" });
		const s3 = stored("user", "recent user");
		const s4 = stored("assistant", "recent answer");

		const sys: Message = systemMsg("sys");
		const m0: Message = userMsg("old user");
		const m1: Message = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		};
		const m2: Message = toolMsg("old tool output", "tc1");
		const m3: Message = userMsg("recent user");
		const m4: Message = assistantMsg("recent answer");

		const compacted = [sys, m0, m1, m2, m3, m4];
		const conversationMessages = [s0, s1, s2, s3, s4];

		// Eviction removes m1 (old assistant tool_call) and m2 (old tool result)
		const evicted = [sys, m0, m3, m4];

		const result = mapEvictedToStored(compacted, evicted, conversationMessages, "sess-1");

		expect(result).toHaveLength(4);

		// With BROKEN positional mapping (i-1), result[2] would be:
		//   conversationMessages[2-1] = conversationMessages[1] = s1 (the OLD assistant)
		// With CORRECT reference mapping, result[2] maps to s3 (the RECENT user)

		expect(result[2].id).toBe(s3.id);
		expect(result[2].content).toBe("recent user");
		expect(result[2].createdAt).toBe(s3.createdAt);

		expect(result[3].id).toBe(s4.id);
		expect(result[3].content).toBe("recent answer");
	});

	test("handles empty conversation (system prompt only)", () => {
		const sys: Message = systemMsg("sys");
		const compacted = [sys];
		const evicted = [sys];

		const result = mapEvictedToStored(compacted, evicted, [], "sess-1");

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("system-dynamic");
		expect(result[0].content).toBe("sys");
	});
});
