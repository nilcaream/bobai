import { describe, expect, test } from "bun:test";
import {
	type CompactionDetail,
	type CompactionStats,
	formatCompactionSummary,
	formatMsgSummary,
	formatToolHeader,
	generateFactorsTable,
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
	test("no detail → returns header with 'excluded'", () => {
		const result = formatToolHeader("tc1", "read_file", undefined);
		expect(result).toBe("tool | tc1 | read_file | excluded");
	});

	test("with detail that wasCompacted with savedChars → includes 'compacted'", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.8,
			position: 0.3,
			normalizedPosition: 0.4,
			distance: 85,
			wasCompacted: true,
			savedChars: 1200,
			outputThreshold: 0.3,
		};
		const result = formatToolHeader("tc1", "read_file", detail);
		expect(result).toStartWith("tool | tc1 | read_file | ");
		expect(result).toContain("distance=85");
		expect(result).toContain("position=0.40");
		expect(result).toContain("factor=0.800");
		expect(result).toContain("output=0.30");
		expect(result).toContain("compacted");
	});

	test("with charsPerToken → includes token savings", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.8,
			position: 0.3,
			normalizedPosition: 0.4,
			distance: 85,
			wasCompacted: true,
			savedChars: 1200,
			outputThreshold: 0.3,
		};
		const result = formatToolHeader("tc1", "read_file", detail, undefined, 3.5);
		expect(result).toContain("tokens=-343");
	});

	test("with detail that was NOT compacted → 'no change'", () => {
		const detail: CompactionDetail = {
			age: 0.1,
			compactionFactor: 0,
			position: 0.1,
			normalizedPosition: 0.1,
			distance: 10,
			wasCompacted: false,
		};
		const result = formatToolHeader("tc1", "bash", detail);
		expect(result).toContain("no change");
	});

	test("with detail belowMinSavings → 'too small'", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.5,
			position: 0.3,
			normalizedPosition: 0.4,
			distance: 50,
			wasCompacted: false,
			belowMinSavings: true,
			outputThreshold: 0.2,
		};
		const result = formatToolHeader("tc1", "write_file", detail);
		expect(result).toContain("too small");
	});

	test("with savedArgsChars → 'compacted'", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.5,
			position: 0.3,
			normalizedPosition: 0.4,
			distance: 50,
			wasCompacted: false,
			savedArgsChars: 500,
			outputThreshold: 0.9,
			argsThreshold: 0.3,
		};
		const result = formatToolHeader("tc1", "edit_file", detail, undefined, 3.5);
		expect(result).toContain("compacted");
		expect(result).toContain("arguments=0.30");
		expect(result).toContain("tokens=-143");
	});

	test("with messageIndex → includes #N prefix", () => {
		const detail: CompactionDetail = {
			age: 0.5,
			compactionFactor: 0.5,
			position: 0.3,
			normalizedPosition: 0.4,
			distance: 50,
			wasCompacted: false,
		};
		const result = formatToolHeader("tc1", "bash", detail, 7);
		expect(result).toStartWith("#7 tool | tc1 | bash | ");
	});
});

// ---------------------------------------------------------------------------
// generateFactorsTable
// ---------------------------------------------------------------------------
describe("generateFactorsTable", () => {
	test("returns 21x21 table", () => {
		const table = generateFactorsTable(0.2, 0.7, 5);
		expect(table).toHaveLength(21);
		for (const row of table) {
			expect(row).toHaveLength(21);
		}
	});

	test("usage below threshold produces all zeros", () => {
		const table = generateFactorsTable(0.2, 0.7, 5);
		// rows 0-4 (usage 0.00 to 0.20) should all be zero
		for (let r = 0; r <= 4; r++) {
			for (const cell of table[r] as number[]) {
				expect(cell).toBe(0);
			}
		}
	});

	test("usage at 1.0 produces non-zero values", () => {
		const table = generateFactorsTable(0.2, 0.7, 5);
		const lastRow = table[20] as number[];
		// At usage=1.0, normPos=0.0 should have high factor (old messages)
		expect(lastRow[0]).toBeGreaterThan(0.5);
		// At usage=1.0, normPos=1.0 should have factor=0 (newest message)
		expect(lastRow[20]).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// formatCompactionSummary
// ---------------------------------------------------------------------------
describe("formatCompactionSummary", () => {
	test("includes all four sections", () => {
		const stats: CompactionStats = {
			usage: 0.35,
			iterations: 7,
			charsBefore: 50000,
			charsAfter: 30000,
			charBudget: 35000,
			charsPerToken: 3.5,
			type: "pre-prompt",
			parameters: {
				threshold: 0.2,
				inflection: 0.7,
				steepness: 5,
				maxAgeDistance: 100,
				evictionDistance: 200,
			},
			estimatedContextNeeded: 0.65,
			target: 0.8,
			elapsedMs: 12.5,
			messagesBefore: { total: 100, system: 1, user: 20, assistant: 40, tool: 39 },
			messagesAfter: { total: 80, system: 1, user: 15, assistant: 30, tool: 34 },
		};
		const result = formatCompactionSummary(stats);

		// Section 1: Parameters
		expect(result).toContain("# Compaction parameters");
		expect(result).toContain("- threshold: 0.2");
		expect(result).toContain("- inflection: 0.7");
		expect(result).toContain("- steepness: 5");
		expect(result).toContain("- max age distance: 100");
		expect(result).toContain("- eviction distance: 200");

		// Section 2: Factors table
		expect(result).toContain("# Usage vs. normalized position");
		expect(result).toContain("| 0.00 |");
		// Vertical axis uses percentage with bold
		expect(result).toContain("**0%**");
		expect(result).toContain("**50%**");
		expect(result).toContain("**100%**");

		// Section 3: Compaction details
		expect(result).toContain("# Compaction details");
		expect(result).toContain("- target context usage: 80%");
		expect(result).toContain("- estimated context needed: 65%");
		expect(result).toContain("- average characters per token: 3.50");
		expect(result).toContain("- total content before compaction: 50000 characters");
		expect(result).toContain("- total content after compaction: 30000 characters");
		expect(result).toContain("- calculated compaction usage: 35%");
		expect(result).toContain("- compaction iterations: 7");
		expect(result).toContain("- compaction time: 12.5ms");

		// Section 4: Context details
		expect(result).toContain("# Context details");
		expect(result).toContain("| total | 100 | 80 |");
		expect(result).toContain("| system | 1 | 1 |");
		expect(result).toContain("| user | 20 | 15 |");
		expect(result).toContain("| assistant | 40 | 30 |");
		expect(result).toContain("| tool | 39 | 34 |");
	});
});
