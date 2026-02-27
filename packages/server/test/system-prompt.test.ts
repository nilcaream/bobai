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

	test("mentions available tools", () => {
		expect(SYSTEM_PROMPT).toContain("read_file");
		expect(SYSTEM_PROMPT).toContain("list_directory");
	});

	test("does not claim inability to read files", () => {
		expect(SYSTEM_PROMPT).not.toContain("cannot read");
		expect(SYSTEM_PROMPT).not.toContain("cannot modify");
		expect(SYSTEM_PROMPT).not.toContain("no access to the project");
	});
});
