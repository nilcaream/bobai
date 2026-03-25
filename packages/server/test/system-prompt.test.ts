import { describe, expect, test } from "bun:test";
import type { InstructionFile } from "../src/instructions";
import type { Skill } from "../src/skill/skill";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../src/system-prompt";

describe("SYSTEM_PROMPT constant", () => {
	test("is a non-empty string", () => {
		expect(typeof SYSTEM_PROMPT).toBe("string");
		expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
	});
});

describe("buildSystemPrompt", () => {
	test("returns base prompt when no skills provided", () => {
		const result = buildSystemPrompt([]);
		expect(result).toBe(SYSTEM_PROMPT);
	});

	test("identifies as Bob AI", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("Bob AI");
	});

	test("mentions available tools", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("read_file");
		expect(result).toContain("list_directory");
		expect(result).toContain("write_file");
		expect(result).toContain("edit_file");
		expect(result).toContain("grep_search");
		expect(result).toContain("bash");
	});

	test("mentions task tool for subagent delegation", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("task");
		expect(result).toContain("subagent");
	});

	test("does not claim inability to read files", () => {
		const result = buildSystemPrompt([]);
		expect(result).not.toContain("cannot read");
		expect(result).not.toContain("cannot modify");
		expect(result).not.toContain("no access to the project");
	});

	test("appends skill listing when skills are provided", () => {
		const skills: Skill[] = [
			{ name: "tdd", description: "Test-driven development workflow", content: "...", filePath: "/a/SKILL.md" },
			{ name: "debugging", description: "Systematic debugging approach", content: "...", filePath: "/b/SKILL.md" },
		];
		const result = buildSystemPrompt(skills);
		expect(result).toContain("## Available Skills");
		expect(result).toContain("- **tdd**: Test-driven development workflow");
		expect(result).toContain("- **debugging**: Systematic debugging approach");
		expect(result).toContain("skill");
	});

	test("skill listing mentions the skill tool", () => {
		const skills: Skill[] = [{ name: "test", description: "A test skill", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills);
		expect(result).toContain("skill");
	});

	test("appends instruction sections when instructions are provided", () => {
		const instructions: InstructionFile[] = [
			{ label: "Global Instructions", source: "/home/user/.config/bobai/AGENT.md", content: "Always use TDD." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain("## Global Instructions");
		expect(result).toContain("Pre-loaded from: /home/user/.config/bobai/AGENT.md");
		expect(result).toContain("Always use TDD.");
	});

	test("appends multiple instruction sections in order", () => {
		const instructions: InstructionFile[] = [
			{ label: "Global Instructions", source: "/global/AGENT.md", content: "Global rules." },
			{ label: "Project Instructions", source: "/project/.bobai/AGENT.md", content: "Project rules." },
		];
		const result = buildSystemPrompt([], instructions);
		const globalIdx = result.indexOf("## Global Instructions");
		const projectIdx = result.indexOf("## Project Instructions");
		expect(globalIdx).toBeGreaterThan(-1);
		expect(projectIdx).toBeGreaterThan(globalIdx);
		expect(result).toContain("Global rules.");
		expect(result).toContain("Project rules.");
	});

	test("instructions appear before skills", () => {
		const instructions: InstructionFile[] = [
			{ label: "Global Instructions", source: "/global/AGENT.md", content: "Be helpful." },
		];
		const skills: Skill[] = [{ name: "tdd", description: "Test-driven development", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills, instructions);
		const instructionIdx = result.indexOf("## Global Instructions");
		const skillIdx = result.indexOf("## Available Skills");
		expect(instructionIdx).toBeGreaterThan(-1);
		expect(skillIdx).toBeGreaterThan(instructionIdx);
	});

	test("returns base prompt when instructions array is empty", () => {
		const result = buildSystemPrompt([], []);
		expect(result).toBe(SYSTEM_PROMPT);
	});
});
