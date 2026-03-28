import { describe, expect, test } from "bun:test";
import { parseSessionUrl, buildSessionUrl } from "../src/urlUtils";

describe("URL parsing", () => {
	test("parseSessionUrl returns null for /bobai/", () => {
		expect(parseSessionUrl("/bobai/")).toEqual({ sessionId: null });
	});

	test("parseSessionUrl returns null for /bobai", () => {
		expect(parseSessionUrl("/bobai")).toEqual({ sessionId: null });
	});

	test("parseSessionUrl extracts session ID", () => {
		expect(parseSessionUrl("/bobai/abc-123")).toEqual({ sessionId: "abc-123" });
	});

	test("parseSessionUrl handles trailing slash", () => {
		expect(parseSessionUrl("/bobai/abc-123/")).toEqual({ sessionId: "abc-123" });
	});

	test("parseSessionUrl ignores query params", () => {
		expect(parseSessionUrl("/bobai/abc-123?foo=bar")).toEqual({ sessionId: "abc-123" });
	});
});

describe("URL building", () => {
	test("buildSessionUrl with null returns /bobai", () => {
		expect(buildSessionUrl(null)).toBe("/bobai");
	});

	test("buildSessionUrl with session ID", () => {
		expect(buildSessionUrl("abc-123")).toBe("/bobai/abc-123");
	});
});
