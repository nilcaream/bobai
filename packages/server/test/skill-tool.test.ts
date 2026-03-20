import { describe, expect, test } from "bun:test";
import type { SkillRegistry } from "../src/skill/skill";
import { createSkillTool } from "../src/tool/skill";

function makeRegistry(skills: Array<{ name: string; description: string; content: string; filePath: string }>): SkillRegistry {
	const map = new Map(skills.map((s) => [s.name, s]));
	return {
		get: (name) => map.get(name),
		list: () => skills,
	};
}

describe("createSkillTool", () => {
	const registry = makeRegistry([
		{
			name: "tdd",
			description: "Test-driven development",
			content: "# TDD\n\nWrite tests first.",
			filePath: "/skills/tdd/SKILL.md",
		},
		{
			name: "debugging",
			description: "Systematic debugging",
			content: "# Debug\n\nReproduce first.",
			filePath: "/skills/debug/SKILL.md",
		},
	]);

	test("definition lists available skill names", () => {
		const tool = createSkillTool(registry);
		const desc = tool.definition.function.description;
		expect(desc).toContain("tdd");
		expect(desc).toContain("debugging");
	});

	test("definition has correct function name", () => {
		const tool = createSkillTool(registry);
		expect(tool.definition.function.name).toBe("skill");
	});

	test("definition requires name parameter", () => {
		const tool = createSkillTool(registry);
		const params = tool.definition.function.parameters as { required: string[] };
		expect(params.required).toContain("name");
	});

	test("execute returns skill content for valid name", async () => {
		const tool = createSkillTool(registry);
		const result = await tool.execute({ name: "tdd" }, { projectRoot: "/project" });
		expect(result.llmOutput).toContain("# TDD");
		expect(result.llmOutput).toContain("Write tests first.");
		expect(result.llmOutput).toContain("/skills/tdd/SKILL.md");
	});

	test("execute returns error for unknown skill", async () => {
		const tool = createSkillTool(registry);
		const result = await tool.execute({ name: "nonexistent" }, { projectRoot: "/project" });
		expect(result.llmOutput).toContain("not found");
		expect(result.llmOutput).toContain("tdd");
		expect(result.llmOutput).toContain("debugging");
	});

	test("formatCall shows skill name with consistent format", () => {
		const tool = createSkillTool(registry);
		expect(tool.formatCall({ name: "tdd" })).toBe("▸ Loading tdd skill");
	});

	test("is mergeable", () => {
		const tool = createSkillTool(registry);
		expect(tool.mergeable).toBe(true);
	});

	test("works with empty registry", () => {
		const emptyRegistry = makeRegistry([]);
		const tool = createSkillTool(emptyRegistry);
		expect(tool.definition.function.description).toContain("skill");
	});

	test("execute on empty registry returns no skills message", async () => {
		const emptyRegistry = makeRegistry([]);
		const tool = createSkillTool(emptyRegistry);
		const result = await tool.execute({ name: "anything" }, { projectRoot: "/project" });
		expect(result.llmOutput).toContain("not found");
		expect(result.llmOutput).toContain("No skills are available");
	});

	test("execute with invalid name returns error", async () => {
		const tool = createSkillTool(registry);
		const result = await tool.execute({ name: 42 }, { projectRoot: "/project" });
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("name");
	});
});
