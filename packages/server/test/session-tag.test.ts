import { describe, expect, test } from "bun:test";
import { sessionScope, subagentScope } from "../src/log/session-tag";

describe("sessionScope", () => {
	test("extracts first UUID segment", () => {
		expect(sessionScope("514cc003-8c07-4183-879c-8fa2311e5e3a")).toBe("514cc003");
	});

	test("returns full string if no dash", () => {
		expect(sessionScope("abcdef")).toBe("abcdef");
	});
});

describe("subagentScope", () => {
	test("combines parent and child prefixes with dash", () => {
		expect(subagentScope("514cc003-8c07-4183-879c-8fa2311e5e3a", "12345678-aaaa-bbbb-cccc-dddddddddddd")).toBe(
			"514cc003-12345678",
		);
	});
});
