import { describe, expect, test } from "bun:test";
import { formatPromptDate } from "../src/format-date";

describe("formatPromptDate", () => {
	// Helper: create a Date whose getTimezoneOffset() returns a specific value.
	// JS getTimezoneOffset() returns minutes *west* of UTC, so UTC+2 → -120.
	function makeDateWithOffset(iso: string, offsetMinutes: number): Date {
		const date = new Date(iso);
		const original = date.getTimezoneOffset;

		// Override instance methods to simulate a specific local timezone
		date.getTimezoneOffset = () => offsetMinutes;

		// Compute the "local" time that this offset implies.
		// Real local = UTC - offsetMinutes. We need to shift the date methods.
		const realOffset = original.call(date);
		const diff = realOffset - offsetMinutes; // minutes to add
		const shifted = new Date(date.getTime() + diff * 60_000);

		date.getFullYear = () => shifted.getFullYear();
		date.getMonth = () => shifted.getMonth();
		date.getDate = () => shifted.getDate();
		date.getDay = () => shifted.getDay();

		return date;
	}

	test("formats a known Monday in UTC+2", () => {
		// 2025-07-14 is a Monday.
		const date = makeDateWithOffset("2025-07-14T12:32:00Z", -120);
		expect(formatPromptDate(date)).toBe("2025-07-14 Mon");
	});

	test("formats a known Friday in UTC+0", () => {
		// 2025-01-03 is a Friday
		const date = makeDateWithOffset("2025-01-03T09:05:00Z", 0);
		expect(formatPromptDate(date)).toBe("2025-01-03 Fri");
	});

	test("formats negative offset (UTC-5)", () => {
		// 2025-06-15 is a Sunday.
		const date = makeDateWithOffset("2025-06-15T20:00:00Z", 300);
		expect(formatPromptDate(date)).toBe("2025-06-15 Sun");
	});

	test("pads month and day with zeros", () => {
		// 2025-03-02 is a Sunday.
		const date = makeDateWithOffset("2025-03-02T05:03:00Z", 300);
		expect(formatPromptDate(date)).toBe("2025-03-02 Sun");
	});

	test("handles non-hour offset UTC+5:30", () => {
		// 2025-08-20 is a Wednesday.
		const date = makeDateWithOffset("2025-08-20T10:00:00Z", -330);
		expect(formatPromptDate(date)).toBe("2025-08-20 Wed");
	});

	test("all day-of-week abbreviations", () => {
		// 2025-07-14 Mon, 15 Tue, 16 Wed, 17 Thu, 18 Fri, 19 Sat, 20 Sun
		const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
		for (let i = 0; i < 7; i++) {
			const date = makeDateWithOffset(`2025-07-${14 + i}T12:00:00Z`, 0);
			expect(formatPromptDate(date)).toContain(days[i]);
		}
	});

	test("midnight edge case", () => {
		// 2025-01-01 Wed at exactly midnight local time (UTC+0)
		const date = makeDateWithOffset("2025-01-01T00:00:00Z", 0);
		expect(formatPromptDate(date)).toBe("2025-01-01 Wed");
	});

	test("end of day edge case", () => {
		// 2025-12-31 Wed at 23:59 local time (UTC+0)
		const date = makeDateWithOffset("2025-12-31T23:59:00Z", 0);
		expect(formatPromptDate(date)).toBe("2025-12-31 Wed");
	});

	test("returns a string when called with no arguments", () => {
		const result = formatPromptDate();
		// Should be a non-empty string matching the expected pattern
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
	});

	test("date rolls over due to timezone offset", () => {
		// UTC 2025-07-14 23:00 in UTC+2 → 2025-07-15 (Tuesday)
		const date = makeDateWithOffset("2025-07-14T23:00:00Z", -120);
		expect(formatPromptDate(date)).toBe("2025-07-15 Tue");
	});

	test("large positive offset UTC+12", () => {
		// 2025-09-01 is a Monday.
		const date = makeDateWithOffset("2025-09-01T00:30:00Z", -720);
		expect(formatPromptDate(date)).toBe("2025-09-01 Mon");
	});

	test("large negative offset UTC-12", () => {
		// 2025-09-01 is a Monday.
		const date = makeDateWithOffset("2025-09-01T23:30:00Z", 720);
		expect(formatPromptDate(date)).toBe("2025-09-01 Mon");
	});
});
