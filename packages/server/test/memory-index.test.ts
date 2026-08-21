import { describe, expect, test } from "bun:test";
import {
	buildMemoryIndex,
	formatMemoryAge,
	MEMORY_INDEX_MAX_ENTRIES,
	memoryAgeDays,
	memoryFreshnessCaveat,
	memorySummary,
	shortMemoryId,
} from "../src/memory/index";
import type { Memory } from "../src/memory/repository";

function memory(overrides: Partial<Memory> & { id: string }): Memory {
	return {
		type: "project",
		title: "Title",
		description: null,
		content: "Content",
		sessionId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("shortMemoryId", () => {
	test("returns first 8 characters", () => {
		expect(shortMemoryId("abcdef12-3456-7890-abcd-ef1234567890")).toBe("abcdef12");
	});
});

describe("memoryAgeDays / formatMemoryAge", () => {
	test("same day is 0 and 'today'", () => {
		expect(memoryAgeDays("2026-08-21T00:00:00.000Z", NOW)).toBe(0);
		expect(formatMemoryAge("2026-08-21T00:00:00.000Z", NOW)).toBe("today");
	});

	test("previous day is 1 and 'yesterday'", () => {
		expect(memoryAgeDays("2026-08-20T12:00:00.000Z", NOW)).toBe(1);
		expect(formatMemoryAge("2026-08-20T12:00:00.000Z", NOW)).toBe("yesterday");
	});

	test("older days count up", () => {
		expect(memoryAgeDays("2026-08-01T12:00:00.000Z", NOW)).toBe(20);
		expect(formatMemoryAge("2026-08-01T12:00:00.000Z", NOW)).toBe("20 days ago");
	});

	test("future dates clamp to 0", () => {
		expect(memoryAgeDays("2026-09-01T00:00:00.000Z", NOW)).toBe(0);
	});

	test("invalid dates clamp to 0", () => {
		expect(memoryAgeDays("not-a-date", NOW)).toBe(0);
	});
});

describe("memoryFreshnessCaveat", () => {
	test("fresh memories (<= 1 day) get no caveat", () => {
		expect(memoryFreshnessCaveat("2026-08-21T00:00:00.000Z", NOW)).toBe("");
		expect(memoryFreshnessCaveat("2026-08-20T12:00:00.000Z", NOW)).toBe("");
	});

	test("older memories get a staleness caveat", () => {
		const caveat = memoryFreshnessCaveat("2026-08-01T00:00:00.000Z", NOW);
		expect(caveat).toContain("20 days old");
		expect(caveat).toContain("verify");
	});
});

describe("memorySummary", () => {
	test("prefers description over content", () => {
		const m = memory({ id: "a", description: "Short summary", content: "Long content" });
		expect(memorySummary(m)).toBe("Short summary");
	});

	test("falls back to first line of content when no description", () => {
		const m = memory({ id: "a", description: null, content: "First line\nSecond line" });
		expect(memorySummary(m)).toBe("First line");
	});

	test("collapses whitespace and truncates long summaries", () => {
		const m = memory({ id: "a", description: `word `.repeat(50) });
		const summary = memorySummary(m);
		expect(summary.length).toBeLessThanOrEqual(120);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("buildMemoryIndex", () => {
	test("returns empty string when there are no memories", () => {
		expect(buildMemoryIndex([], NOW)).toBe("");
	});

	test("includes header and one entry per memory", () => {
		const memories = [
			memory({ id: "aaaaaaaa-1111", type: "feedback", title: "Use real DB", description: "No mocks" }),
			memory({ id: "bbbbbbbb-2222", type: "project", title: "Q1 freeze", description: "Starts March 5" }),
		];
		const index = buildMemoryIndex(memories, NOW);
		expect(index).toContain("## Project Memory");
		expect(index).toContain("`aaaaaaaa` [feedback] Use real DB — No mocks");
		expect(index).toContain("`bbbbbbbb` [project] Q1 freeze — Starts March 5");
	});

	test("caps entries at MEMORY_INDEX_MAX_ENTRIES and reports hidden count", () => {
		const memories = Array.from({ length: MEMORY_INDEX_MAX_ENTRIES + 10 }, (_, i) =>
			memory({ id: `id-${String(i).padStart(4, "0")}`, title: `Memory ${i}` }),
		);
		const index = buildMemoryIndex(memories, NOW);
		const entryLines = index.split("\n").filter((l) => l.startsWith("- "));
		expect(entryLines).toHaveLength(MEMORY_INDEX_MAX_ENTRIES);
		expect(index).toContain("10 more memories not shown");
	});

	test("does not report hidden count when everything fits", () => {
		const memories = [memory({ id: "aaaaaaaa-1111", title: "Only one" })];
		expect(buildMemoryIndex(memories, NOW)).not.toContain("more memories not shown");
	});

	test("stays under the byte cap even with huge entries", () => {
		const huge = memory({
			id: "aaaaaaaa-1111",
			title: "T".repeat(1000),
			description: "D".repeat(5000),
		});
		// 64 entries, each enormous — the byte cap must stop well before 32.
		const memories = Array.from({ length: 64 }, (_, i) => ({ ...huge, id: `id-${i}-xxxx` }));
		const index = buildMemoryIndex(memories, NOW);
		expect(Buffer.byteLength(index, "utf8")).toBeLessThan(5000);
	});
});
