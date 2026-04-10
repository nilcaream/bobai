import { describe, expect, test } from "bun:test";
import { formatStoredTimestamp, formatTimestamp } from "../src/format";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("formatTimestamp", () => {
	test("returns a string matching YYYY-MM-DD HH:MM:SS", () => {
		const result = formatTimestamp();
		expect(result).toMatch(TIMESTAMP_PATTERN);
	});

	test("zero-pads single-digit components", () => {
		// formatTimestamp uses new Date() internally, so we can only verify
		// the format pattern. All segments must be exactly 2 digits (except year=4).
		const result = formatTimestamp();
		const [datePart, timePart] = result.split(" ");
		const [year, month, day] = datePart.split("-");
		const [hours, minutes, seconds] = timePart.split(":");
		expect(year).toHaveLength(4);
		expect(month).toHaveLength(2);
		expect(day).toHaveLength(2);
		expect(hours).toHaveLength(2);
		expect(minutes).toHaveLength(2);
		expect(seconds).toHaveLength(2);
	});
});

describe("formatStoredTimestamp", () => {
	test("returns a string matching YYYY-MM-DD HH:MM:SS", () => {
		const result = formatStoredTimestamp("2025-06-15T12:30:45.000Z");
		expect(result).toMatch(TIMESTAMP_PATTERN);
	});

	test("formats a known ISO string to the expected local representation", () => {
		// Build the expected value from the same Date to avoid timezone issues
		const iso = "2025-01-15T08:05:03.000Z";
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, "0");
		const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

		expect(formatStoredTimestamp(iso)).toBe(expected);
	});

	test("zero-pads months and hours below 10", () => {
		// Use a date that guarantees single-digit month and hour in UTC
		// (local TZ may shift, but the format must still be padded)
		const result = formatStoredTimestamp("2025-01-02T03:04:05.000Z");
		expect(result).toMatch(TIMESTAMP_PATTERN);
		// Every numeric segment (except year) must be exactly 2 chars
		const [datePart, timePart] = result.split(" ");
		const [, month, day] = datePart.split("-");
		const [hours, minutes, seconds] = timePart.split(":");
		expect(month).toHaveLength(2);
		expect(day).toHaveLength(2);
		expect(hours).toHaveLength(2);
		expect(minutes).toHaveLength(2);
		expect(seconds).toHaveLength(2);
	});
});
