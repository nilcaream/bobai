import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../src/system-prompt";

describe("system prompt", () => {
	test("is a non-empty string", () => {
		expect(typeof SYSTEM_PROMPT).toBe("string");
		expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
	});

	test("identifies as Bob AI", () => {
		expect(SYSTEM_PROMPT).toContain("Bob AI");
	});

	test("states limitations", () => {
		// Should mention it cannot access files (yet)
		expect(SYSTEM_PROMPT.toLowerCase()).toContain("cannot");
	});
});
