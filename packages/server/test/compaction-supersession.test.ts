import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { compactMessages } from "../src/compaction/engine";
import {
	buildSupersessionMap,
	detectSupersessions,
	SUPERSESSION_STRENGTH_BOOST,
	supersededMarker,
} from "../src/compaction/supersession";
import type { Message } from "../src/provider/provider";
import type { ToolRegistry } from "../src/tool/tool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an assistant message with a single tool call. */
function assistantToolCall(id: string, toolName: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
	};
}

/** Create a tool result message. */
function toolResult(id: string, content: string): Message {
	return { role: "tool", content, tool_call_id: id };
}

/** Create a minimal tool registry with no custom compact methods. */
function emptyRegistry(): ToolRegistry {
	return {
		definitions: [],
		get: () => undefined,
	};
}

// ---------------------------------------------------------------------------
// Unit tests: detectSupersessions
// ---------------------------------------------------------------------------

describe("detectSupersessions", () => {
	describe("Rule 1: retry/correction", () => {
		test("detects duplicate read_file with same path", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "file content v1"),
				assistantToolCall("c2", "read_file", { path: "/src/foo.ts" }),
				toolResult("c2", "file content v2"),
			];
			const result = detectSupersessions(messages);
			expect(result).toHaveLength(1);
			expect(result[0]!.toolCallId).toBe("c1");
			expect(result[0]!.reason).toContain("superseded by later read_file");
		});

		test("detects duplicate bash with same command", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "npm test" }),
				toolResult("c1", "FAIL\nexit code: 1"),
				assistantToolCall("c2", "bash", { command: "npm test" }),
				toolResult("c2", "PASS\nexit code: 0"),
			];
			const result = detectSupersessions(messages);
			expect(result).toHaveLength(1);
			expect(result[0]!.toolCallId).toBe("c1");
		});

		test("does not flag calls with different args", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "foo"),
				assistantToolCall("c2", "read_file", { path: "/src/bar.ts" }),
				toolResult("c2", "bar"),
			];
			const result = detectSupersessions(messages);
			expect(result).toHaveLength(0);
		});

		test("keeps only the last of 3+ duplicate calls", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "make" }),
				toolResult("c1", "error\nexit code: 2"),
				assistantToolCall("c2", "bash", { command: "make" }),
				toolResult("c2", "error\nexit code: 1"),
				assistantToolCall("c3", "bash", { command: "make" }),
				toolResult("c3", "ok\nexit code: 0"),
			];
			const result = detectSupersessions(messages);
			const ids = result.map((s) => s.toolCallId);
			expect(ids).toContain("c1");
			expect(ids).toContain("c2");
			expect(ids).not.toContain("c3");
		});
	});

	describe("Rule 2: stale reads", () => {
		test("detects read before edit on same file", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "old content"),
				assistantToolCall("c2", "edit_file", { path: "/src/foo.ts" }),
				toolResult("c2", "edit applied"),
			];
			const result = detectSupersessions(messages);
			const staleRead = result.find((s) => s.toolCallId === "c1");
			expect(staleRead).toBeDefined();
			expect(staleRead!.reason).toContain("stale read");
		});

		test("detects read before write_file on same file", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "old content"),
				assistantToolCall("c2", "write_file", { path: "/src/foo.ts" }),
				toolResult("c2", "written"),
			];
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.toolCallId === "c1")).toBeDefined();
		});

		test("does not flag read AFTER edit", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "edit_file", { path: "/src/foo.ts" }),
				toolResult("c1", "edit applied"),
				assistantToolCall("c2", "read_file", { path: "/src/foo.ts" }),
				toolResult("c2", "new content"),
			];
			const result = detectSupersessions(messages);
			const staleRead = result.find((s) => s.toolCallId === "c2" && s.reason.includes("stale"));
			expect(staleRead).toBeUndefined();
		});

		test("does not flag read on different file", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "content"),
				assistantToolCall("c2", "edit_file", { path: "/src/bar.ts" }),
				toolResult("c2", "edited"),
			];
			const result = detectSupersessions(messages);
			const staleRead = result.find((s) => s.reason.includes("stale"));
			expect(staleRead).toBeUndefined();
		});
	});

	describe("Rule 3: failed bash", () => {
		test("detects non-zero exit code", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "make" }),
				toolResult("c1", "error: something failed\nexit code: 1"),
			];
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.toolCallId === "c1")).toBeDefined();
			expect(result.find((s) => s.toolCallId === "c1")!.reason).toContain("failed bash");
		});

		test("does not flag exit code 0", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "ls" }),
				toolResult("c1", "file1.ts\nfile2.ts\nexit code: 0"),
			];
			const result = detectSupersessions(messages);
			const failed = result.find((s) => s.reason.includes("failed bash"));
			expect(failed).toBeUndefined();
		});

		test("detects timed out commands", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "sleep 100" }),
				toolResult("c1", "Command timed out after 30s"),
			];
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.toolCallId === "c1")!.reason).toContain("timed out");
		});

		test("detects exit code on second-to-last line", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "bash", { command: "make" }),
				toolResult("c1", "output\nexit code: 2\n"),
			];
			// split("\n") gives ["output", "exit code: 2", ""]
			// lastLine = "", secondLast = "exit code: 2"
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.reason.includes("failed bash"))).toBeDefined();
		});
	});

	describe("Rule 4: search refinement", () => {
		test("detects multiple file_search calls (different patterns)", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "file_search", { pattern: "*.ts" }),
				toolResult("c1", "a.ts\nb.ts"),
				assistantToolCall("c2", "file_search", { pattern: "src/*.ts" }),
				toolResult("c2", "src/a.ts"),
			];
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.toolCallId === "c1")).toBeDefined();
			expect(result.find((s) => s.toolCallId === "c1")!.reason).toContain("refinement");
		});

		test("detects multiple grep_search calls", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "grep_search", { pattern: "TODO" }),
				toolResult("c1", "a.ts:1: TODO fix"),
				assistantToolCall("c2", "grep_search", { pattern: "TODO fix" }),
				toolResult("c2", "a.ts:1: TODO fix this"),
			];
			const result = detectSupersessions(messages);
			expect(result.find((s) => s.toolCallId === "c1")).toBeDefined();
		});

		test("does not flag single search call", () => {
			const messages: Message[] = [assistantToolCall("c1", "file_search", { pattern: "*.ts" }), toolResult("c1", "a.ts")];
			const result = detectSupersessions(messages);
			const refinement = result.find((s) => s.reason.includes("refinement"));
			expect(refinement).toBeUndefined();
		});

		test("handles file_search and grep_search independently", () => {
			const messages: Message[] = [
				assistantToolCall("c1", "file_search", { pattern: "*.ts" }),
				toolResult("c1", "a.ts"),
				assistantToolCall("c2", "grep_search", { pattern: "TODO" }),
				toolResult("c2", "match"),
			];
			// One of each — no refinement
			const result = detectSupersessions(messages);
			const refinement = result.find((s) => s.reason.includes("refinement"));
			expect(refinement).toBeUndefined();
		});
	});

	describe("deduplication", () => {
		test("deduplicates across rules (first reason wins)", () => {
			// A read_file that is both a retry (Rule 1) and a stale read (Rule 2)
			const messages: Message[] = [
				assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
				toolResult("c1", "old content"),
				assistantToolCall("c2", "edit_file", { path: "/src/foo.ts" }),
				toolResult("c2", "edit applied"),
				assistantToolCall("c3", "read_file", { path: "/src/foo.ts" }),
				toolResult("c3", "new content"),
			];
			const result = detectSupersessions(messages);
			// c1 is superseded by both retry (c3 same tool+arg) and stale read (c2 edits same file)
			const c1Entries = result.filter((s) => s.toolCallId === "c1");
			expect(c1Entries).toHaveLength(1); // deduplicated
		});
	});
});

// ---------------------------------------------------------------------------
// Unit tests: helper functions
// ---------------------------------------------------------------------------

describe("buildSupersessionMap", () => {
	test("builds map from toolCallId to reason", () => {
		const supersessions = [
			{ toolCallId: "c1", reason: "reason 1" },
			{ toolCallId: "c2", reason: "reason 2" },
		];
		const map = buildSupersessionMap(supersessions);
		expect(map.get("c1")).toBe("reason 1");
		expect(map.get("c2")).toBe("reason 2");
		expect(map.size).toBe(2);
	});
});

describe("supersededMarker", () => {
	test("includes COMPACTION_MARKER, tool name, and reason", () => {
		const result = supersededMarker("read_file", "stale read");
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("read_file");
		expect(result).toContain("stale read");
	});
});

describe("SUPERSESSION_STRENGTH_BOOST", () => {
	test("is greater than 1", () => {
		expect(SUPERSESSION_STRENGTH_BOOST).toBeGreaterThan(1);
	});
});

// ---------------------------------------------------------------------------
// Integration: supersession in compactMessages engine
// ---------------------------------------------------------------------------

describe("compactMessages with supersession", () => {
	test("superseded messages get COMPACTED marker even with no context pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
			toolResult("c1", "old content"),
			assistantToolCall("c2", "read_file", { path: "/src/foo.ts" }),
			toolResult("c2", "new content"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 100, contextWindow: 10000 }, // low pressure, below 40%
			tools: emptyRegistry(),
		});

		// c1's tool result should be superseded
		const c1Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c1") as
			| { content: string }
			| undefined;
		expect(c1Result).toBeDefined();
		expect(c1Result!.content).toContain(COMPACTION_MARKER);
		expect(c1Result!.content).toContain("superseded");

		// c2's tool result should be untouched
		const c2Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c2") as
			| { content: string }
			| undefined;
		expect(c2Result).toBeDefined();
		expect(c2Result!.content).toBe("new content");
	});

	test("superseded messages get boosted strength under pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			assistantToolCall("c1", "bash", { command: "make" }),
			toolResult("c1", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\nexit code: 1"),
			assistantToolCall("c2", "bash", { command: "make" }),
			toolResult("c2", "ok\nexit code: 0"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 8000, contextWindow: 10000 }, // high pressure
			tools: emptyRegistry(),
		});

		// c1 is superseded (retry + failed bash) — should be compacted aggressively
		const c1Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c1") as
			| { content: string }
			| undefined;
		expect(c1Result).toBeDefined();
		expect(c1Result!.content).toContain(COMPACTION_MARKER);
	});

	test("non-superseded messages are unchanged when no pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
			toolResult("c1", "content"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 100, contextWindow: 10000 },
			tools: emptyRegistry(),
		});

		const c1Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c1") as
			| { content: string }
			| undefined;
		expect(c1Result!.content).toBe("content");
	});

	test("system and user messages are never modified by supersession", () => {
		const messages: Message[] = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "user message" },
			assistantToolCall("c1", "read_file", { path: "/src/foo.ts" }),
			toolResult("c1", "content"),
			assistantToolCall("c2", "read_file", { path: "/src/foo.ts" }),
			toolResult("c2", "content v2"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 100, contextWindow: 10000 },
			tools: emptyRegistry(),
		});

		expect(result[0]).toEqual({ role: "system", content: "system prompt" });
		expect(result[1]).toEqual({ role: "user", content: "user message" });
	});

	test("stale read detected and marked across edit", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			assistantToolCall("c1", "read_file", { path: "/app.ts" }),
			toolResult("c1", "original code"),
			assistantToolCall("c2", "edit_file", { path: "/app.ts" }),
			toolResult("c2", "edit applied"),
			assistantToolCall("c3", "read_file", { path: "/app.ts" }),
			toolResult("c3", "updated code"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 100, contextWindow: 10000 },
			tools: emptyRegistry(),
		});

		// c1 should be superseded (stale read before edit + retry with c3)
		const c1Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c1") as
			| { content: string }
			| undefined;
		expect(c1Result!.content).toContain(COMPACTION_MARKER);

		// c3 is fresh — should be untouched
		const c3Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c3") as
			| { content: string }
			| undefined;
		expect(c3Result!.content).toBe("updated code");
	});

	test("failed bash superseded even with low pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			assistantToolCall("c1", "bash", { command: "deploy" }),
			toolResult("c1", "fatal error\nexit code: 127"),
		];

		const result = compactMessages({
			messages,
			context: { promptTokens: 100, contextWindow: 10000 },
			tools: emptyRegistry(),
		});

		const c1Result = result.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "c1") as
			| { content: string }
			| undefined;
		expect(c1Result!.content).toContain(COMPACTION_MARKER);
		expect(c1Result!.content).toContain("failed bash");
	});
});
