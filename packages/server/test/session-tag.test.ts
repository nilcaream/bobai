import { describe, expect, test } from "bun:test";
import { sessionTag, subagentTag } from "../src/log/session-tag";

describe("sessionTag", () => {
	test("extracts first UUID segment", () => {
		expect(sessionTag("514cc003-8c07-4183-879c-8fa2311e5e3a")).toBe("514cc003");
	});

	test("returns full string if no dash", () => {
		expect(sessionTag("abcdef")).toBe("abcdef");
	});
});

describe("subagentTag", () => {
	test("combines parent and child prefixes with colon", () => {
		expect(subagentTag("514cc003-8c07-4183-879c-8fa2311e5e3a", "12345678-aaaa-bbbb-cccc-dddddddddddd")).toBe(
			"514cc003:12345678",
		);
	});
});
