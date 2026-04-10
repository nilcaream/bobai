import { describe, expect, test } from "bun:test";
import {
	type CompactionDetail,
	formatMsgSummary,
	formatToolHeader,
	groupParts,
	truncateChars,
	truncateContent,
} from "../src/formatUtils";
import type { MessagePart } from "../src/protocol";

// ---------------------------------------------------------------------------
// groupParts
// ---------------------------------------------------------------------------
describe("groupParts", () => {
	test("empty parts list → empty array", () => {
		expect(groupParts([])).toEqual([]);
	});

	test("single text part → single text panel", () => {
		const parts: MessagePart[] = [{ type: "text", content: "hello" }];
		expect(groupParts(parts)).toEqual([{ type: "text", content: "hello" }]);
	});

	test("single tool_call → single incomplete tool panel", () => {
		const parts: MessagePart[] = [{ type: "tool_call", id: "tc1", content: "running..." }];
		expect(groupParts(parts)).toEqual([{ type: "tool", id: "tc1", content: "running...", completed: false, mergeable: false }]);
	});

	test("tool_call followed by matching tool_result → single completed tool panel with result content", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "running..." },
			{ type: "tool_result", id: "tc1", content: "done!", mergeable: false },
		];
		expect(groupParts(parts)).toEqual([{ type: "tool", id: "tc1", content: "done!", completed: true, mergeable: false }]);
	});

	test("tool_call followed by tool_result with null content → completed panel keeps tool_call content", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "running..." },
			{ type: "tool_result", id: "tc1", content: null, mergeable: false },
		];
		expect(groupParts(parts)).toEqual([{ type: "tool", id: "tc1", content: "running...", completed: true, mergeable: false }]);
	});

	test("two adjacent completed+mergeable tool panels → merged into one panel", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "result1" },
			{ type: "tool_result", id: "tc1", content: "result1", mergeable: true },
			{ type: "tool_call", id: "tc2", content: "result2" },
			{ type: "tool_result", id: "tc2", content: "result2", mergeable: true },
		];
		const result = groupParts(parts);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			type: "tool",
			id: "tc1",
			content: "result1  \nresult2",
			completed: true,
			mergeable: true,
		});
	});

	test("text between two tool panels → three panels, no merging", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "r1" },
			{ type: "tool_result", id: "tc1", content: "r1", mergeable: true },
			{ type: "text", content: "separator" },
			{ type: "tool_call", id: "tc2", content: "r2" },
			{ type: "tool_result", id: "tc2", content: "r2", mergeable: true },
		];
		const result = groupParts(parts);
		expect(result).toHaveLength(3);
		expect(result[0]?.type).toBe("tool");
		expect(result[1]).toEqual({ type: "text", content: "separator" });
		expect(result[2]?.type).toBe("tool");
	});

	test("tool_result with summary → panel has summary field", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "running..." },
			{ type: "tool_result", id: "tc1", content: "done", mergeable: false, summary: "read 5 files" },
		];
		const result = groupParts(parts);
		expect(result).toHaveLength(1);
		const panel = result[0] as { type: "tool"; summary?: string };
		expect(panel.summary).toBe("read 5 files");
	});

	test("tool_result with subagentSessionId → panel has subagentSessionId field", () => {
		const parts: MessagePart[] = [
			{ type: "tool_call", id: "tc1", content: "running..." },
			{
				type: "tool_result",
				id: "tc1",
				content: "done",
				mergeable: false,
				subagentSessionId: "sub-123",
			},
		];
		const result = groupParts(parts);
		expect(result).toHaveLength(1);
		const panel = result[0] as { type: "tool"; subagentSessionId?: string };
		expect(panel.subagentSessionId).toBe("sub-123");
	});
});

// ---------------------------------------------------------------------------
// truncateContent
// ---------------------------------------------------------------------------
describe("truncateContent", () => {
	test("text shorter than limit → returned as-is (trimmed)", () => {
		expect(truncateContent("  hello  ", 10)).toBe("hello");
	});

	test("text at exactly the limit → returned as-is", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		expect(truncateContent(lines, 40)).toBe(lines);
	});

	test("text over limit → head (20 lines) + ellipsis + tail (20 lines)", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		const result = truncateContent(lines.join("\n"), 48);
		const resultLines = result.split("\n");
		// head = 20 lines, ellipsis = 1 line, tail = 20 lines
		expect(resultLines).toHaveLength(41);
		expect(resultLines[0]).toBe("line 1");
		expect(resultLines[19]).toBe("line 20");
		expect(resultLines[20]).toBe("... (60 more lines)");
		expect(resultLines[21]).toBe("line 81");
		expect(resultLines[40]).toBe("line 100");
	});

	test("lineLimit of 0 → returns full text trimmed", () => {
		expect(truncateContent("  full text  ", 0)).toBe("full text");
	});

	test("empty string → empty string", () => {
		expect(truncateContent("", 48)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// truncateChars
// ---------------------------------------------------------------------------
describe("truncateChars", () => {
	test("text shorter than limit → returned as-is", () => {
		expect(truncateChars("hello", 100)).toBe("hello");
	});

	test("text over limit → truncated + ellipsis with char count", () => {
		expect(truncateChars("abcdefghij", 5)).toBe("abcde... (5 more chars)");
	});

	test("charLimit of 0 → full text", () => {
		expect(truncateChars("hello", 0)).toBe("hello");
	});

	test("empty string → empty string", () => {
		expect(truncateChars("", 10)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatMsgSummary
// ---------------------------------------------------------------------------
describe("formatMsgSummary", () => {
	test("message with summary → returns the summary", () => {
		expect(formatMsgSummary({ summary: "quick summary" })).toBe("quick summary");
	});

	test("message with model only → returns ' | model'", () => {
		expect(formatMsgSummary({ model: "gpt-4" })).toBe(" | gpt-4");
	});

	test("message with both → returns summary (summary takes precedence)", () => {
		expect(formatMsgSummary({ summary: "quick summary", model: "gpt-4" })).toBe("quick summary");
	});

	test("message with neither → returns empty string", () => {
		expect(formatMsgSummary({})).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatToolHeader
// ---------------------------------------------------------------------------
describe("formatToolHeader", () => {
	test("no detail → returns header with 'no detail available'", () => {
		const result = formatToolHeader("tc1", "read_file", undefined);
		expect(result).toBe("tool | tc1 | read_file | no detail available");
	});

	test("with detail that wasCompacted with savedChars → includes compacted savings", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.8,
			position: 0.3,
			normalizedPosition: 0.4,
			wasCompacted: true,
			savedChars: 1200,
		};
		const result = formatToolHeader("tc1", "read_file", detail);
		expect(result).toContain("compacted (saved 1200 chars)");
		expect(result).toStartWith("tool | tc1 | read_file");
	});

	test("with detail that was NOT compacted, factor <= 0 → 'no pressure'", () => {
		const detail: CompactionDetail = {
			age: 0.1,
			compactionFactor: 0,
			position: 0.1,
			normalizedPosition: 0.1,
			wasCompacted: false,
		};
		const result = formatToolHeader("tc1", "bash", detail);
		expect(result).toContain("no pressure");
	});

	test("with detail belowMinSavings → 'savings below minimum'", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.5,
			position: 0.3,
			normalizedPosition: 0.4,
			wasCompacted: false,
			belowMinSavings: true,
		};
		const result = formatToolHeader("tc1", "write_file", detail);
		expect(result).toContain("savings below minimum");
	});

	test("with detail kept (factor > 0, not compacted, not belowMinSavings) → 'kept'", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.5,
			position: 0.3,
			normalizedPosition: 0.4,
			wasCompacted: false,
		};
		const result = formatToolHeader("tc1", "grep_search", detail);
		expect(result).toContain("kept");
	});
});
