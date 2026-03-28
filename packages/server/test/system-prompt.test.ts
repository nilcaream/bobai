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
	test("wraps base prompt in <base> tags", () => {
		const result = buildSystemPrompt([]);
		expect(result).toStartWith("<base>\n");
		expect(result).toContain("\n</base>");
	});

	test("returns only base section when no skills or instructions provided", () => {
		const result = buildSystemPrompt([]);
		expect(result).toBe(`<base>\n${SYSTEM_PROMPT}\n</base>`);
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

	test("wraps skills in <skills> tags", () => {
		const skills: Skill[] = [
			{ name: "tdd", description: "Test-driven development workflow", content: "...", filePath: "/a/SKILL.md" },
		];
		const result = buildSystemPrompt(skills);
		expect(result).toContain("<skills>\n## Available Skills");
		expect(result).toContain("\n</skills>");
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

	test("wraps instructions in <instructions> tags with type attribute", () => {
		const instructions: InstructionFile[] = [
			{ type: "global", source: "/home/user/.config/bobai/AGENT.md", content: "Always use TDD." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain('<instructions type="global">');
		expect(result).not.toContain("source=");
		expect(result).toContain("Always use TDD.");
		expect(result).toContain("</instructions>");
	});

	test("appends multiple instruction sections in order", () => {
		const instructions: InstructionFile[] = [
			{ type: "global", source: "/global/AGENT.md", content: "Global rules." },
			{ type: "project", source: "/project/.bobai/AGENT.md", content: "Project rules." },
		];
		const result = buildSystemPrompt([], instructions);
		const globalIdx = result.indexOf('<instructions type="global"');
		const projectIdx = result.indexOf('<instructions type="project"');
		expect(globalIdx).toBeGreaterThan(-1);
		expect(projectIdx).toBeGreaterThan(globalIdx);
		expect(result).toContain("Global rules.");
		expect(result).toContain("Project rules.");
	});

	test("skills appear before instructions", () => {
		const instructions: InstructionFile[] = [{ type: "global", source: "/global/AGENT.md", content: "Be helpful." }];
		const skills: Skill[] = [{ name: "tdd", description: "Test-driven development", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills, instructions);
		const skillIdx = result.indexOf("<skills>");
		const instructionIdx = result.indexOf("<instructions");
		expect(skillIdx).toBeGreaterThan(-1);
		expect(instructionIdx).toBeGreaterThan(skillIdx);
	});

	test("returns only base section when instructions array is empty", () => {
		const result = buildSystemPrompt([], []);
		expect(result).toBe(`<base>\n${SYSTEM_PROMPT}\n</base>`);
	});

	test("context compaction section uses plain label instead of markdown heading", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("Context Compaction:");
		expect(result).not.toContain("## Context Compaction");
	});
});
