import { describe, expect, test } from "bun:test";
import { builtinSkills } from "../src/skill/builtin";
import { parseSkillFile } from "../src/skill/skill";

describe("builtinSkills", () => {
	test("all entries parse successfully", () => {
		for (const entry of builtinSkills) {
			const skill = parseSkillFile(entry.raw, entry.relativePath);
			expect(skill).not.toBeNull();
			expect(skill?.name).toBeTruthy();
			expect(skill?.description).toBeTruthy();
		}
	});

	test("debugging-bobai-sessions has mode: debug", () => {
		const entry = builtinSkills.find((s) => s.relativePath.includes("debugging-bobai-sessions"));
		expect(entry).toBeDefined();
		if (!entry) return;
		const skill = parseSkillFile(entry.raw, entry.relativePath);
		expect(skill?.mode).toBe("debug");
	});
});
