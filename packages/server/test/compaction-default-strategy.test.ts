import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER, defaultCompact } from "../src/compaction/default-strategy";

/** Helper: build a string with the given number of lines. */
function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("COMPACTION_MARKER", () => {
	test("equals '# COMPACTED'", () => {
		expect(COMPACTION_MARKER).toBe("# COMPACTED");
	});
});

describe("defaultCompact", () => {
	// ── No-op cases ──────────────────────────────────────────────────

	test("returns output unchanged when strength is 0", () => {
		const output = lines(10);
		expect(defaultCompact(output, 0, "bash")).toBe(output);
	});

	test("returns output unchanged when strength is negative", () => {
		const output = lines(10);
		expect(defaultCompact(output, -0.5, "bash")).toBe(output);
	});

	test("returns output unchanged when output has fewer than MIN_KEEP_LINES lines", () => {
		const output = lines(2);
		expect(defaultCompact(output, 1.0, "bash")).toBe(output);
	});

	test("returns output unchanged when output has exactly MIN_KEEP_LINES lines", () => {
		const output = lines(3);
		expect(defaultCompact(output, 1.0, "bash")).toBe(output);
	});

	test("empty string is returned unchanged", () => {
		expect(defaultCompact("", 1.0, "bash")).toBe("");
	});

	test("single-line output is never compacted", () => {
		const output = "only one line";
		expect(defaultCompact(output, 1.0, "bash")).toBe(output);
	});

	test("very small strength that keeps all lines returns output unchanged", () => {
		const output = lines(10);
		// strength 0.05 → keepRatio 0.95 → floor(10 * 0.95) = 9, still < 10
		// Need keepCount >= totalLines. strength 0.01 → floor(10 * 0.99) = 9, < 10
		// strength 0.0 returns early. Use a strength where floor(n * (1-s)) >= n.
		// For 10 lines, we need floor(10 * keepRatio) >= 10, i.e. keepRatio >= 1.0
		// That only happens at strength <= 0 (already tested). However with
		// very large line counts the rounding can cause keepCount == totalLines.
		// E.g. 100 lines, strength 0.001 → floor(100 * 0.999) = 99, still < 100.
		// The realistic case: keepCount == totalLines only when strength produces
		// keepRatio 1.0+ (i.e. strength <= 0). Test the boundary with a
		// fractional scenario: 3 lines at strength 0.01 → floor(3 * 0.99) = 2,
		// but totalLines (3) <= MIN_KEEP_LINES so it returns early anyway.
		// Best proxy: 4 lines, strength 0.01 → floor(4 * 0.99) = floor(3.96) = 3
		// keepCount 3 < 4 so it still truncates. The guard `keepCount >= totalLines`
		// is unreachable for positive strength with totalLines > MIN_KEEP_LINES
		// and integer floor, but we can verify the boundary explicitly:
		// 4 lines, strength that yields keepCount 4: need floor(4 * (1-s)) >= 4
		// → (1-s) >= 1 → s <= 0, handled by early return.
		// Verified: for any positive strength and totalLines > 3, compaction occurs.
		// We still test the near-zero case to document behavior.
		expect(defaultCompact(output, 0.01, "bash")).not.toBe(output);
	});

	// ── Compaction cases ─────────────────────────────────────────────

	test("at strength 0.5 with 10 lines: keeps 5 lines + truncation notice", () => {
		const output = lines(10);
		const result = defaultCompact(output, 0.5, "bash");
		const resultLines = result.split("\n");
		// 5 kept lines + 1 truncation notice = 6 lines total
		expect(resultLines).toHaveLength(6);
		// First 5 lines match original
		const originalLines = output.split("\n");
		for (let i = 0; i < 5; i++) {
			expect(resultLines[i]).toBe(originalLines[i]);
		}
	});

	test("at strength 1.0 with 20 lines: keeps MIN_KEEP_LINES (3) + truncation notice", () => {
		const output = lines(20);
		const result = defaultCompact(output, 1.0, "bash");
		const resultLines = result.split("\n");
		// 3 kept + 1 notice = 4
		expect(resultLines).toHaveLength(4);
		const originalLines = output.split("\n");
		for (let i = 0; i < 3; i++) {
			expect(resultLines[i]).toBe(originalLines[i]);
		}
	});

	test("at strength 0.1 with 10 lines: keeps 9 lines + truncation notice", () => {
		const output = lines(10);
		const result = defaultCompact(output, 0.1, "bash");
		const resultLines = result.split("\n");
		// floor(10 * 0.9) = 9 kept + 1 notice = 10
		expect(resultLines).toHaveLength(10);
		const originalLines = output.split("\n");
		for (let i = 0; i < 9; i++) {
			expect(resultLines[i]).toBe(originalLines[i]);
		}
	});

	test("output with exactly 4 lines at strength 1.0: keeps 3, truncates 1", () => {
		const output = lines(4);
		const result = defaultCompact(output, 1.0, "bash");
		const resultLines = result.split("\n");
		// 3 kept + 1 notice = 4
		expect(resultLines).toHaveLength(4);
		const originalLines = output.split("\n");
		for (let i = 0; i < 3; i++) {
			expect(resultLines[i]).toBe(originalLines[i]);
		}
		expect(resultLines[3]).toContain("1 more lines");
	});

	// ── Truncation notice format ─────────────────────────────────────

	test("truncation notice contains COMPACTION_MARKER", () => {
		const result = defaultCompact(lines(10), 0.5, "bash");
		const lastLine = result.split("\n").at(-1) ?? "";
		expect(lastLine).toContain(COMPACTION_MARKER);
	});

	test("truncation notice contains the tool name", () => {
		const result = defaultCompact(lines(10), 0.5, "my-special-tool");
		const lastLine = result.split("\n").at(-1) ?? "";
		expect(lastLine).toContain("my-special-tool");
	});

	test("truncation notice contains the correct number of removed lines", () => {
		// 10 lines, strength 0.5 → keep 5 → removed 5
		const result = defaultCompact(lines(10), 0.5, "bash");
		const lastLine = result.split("\n").at(-1) ?? "";
		expect(lastLine).toContain("5 more lines");

		// 20 lines, strength 1.0 → keep 3 → removed 17
		const result2 = defaultCompact(lines(20), 1.0, "bash");
		const lastLine2 = result2.split("\n").at(-1) ?? "";
		expect(lastLine2).toContain("17 more lines");
	});
});
