import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills, parseSkillFile } from "../src/skill/skill";

describe("parseSkillFile", () => {
	test("parses valid SKILL.md with name and description", () => {
		const content = ["---", "name: my-skill", "description: A helpful skill", "---", "# My Skill", "", "Do the thing."].join(
			"\n",
		);
		const result = parseSkillFile(content, "/path/to/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("my-skill");
		expect(result?.description).toBe("A helpful skill");
		expect(result?.content).toContain("# My Skill");
		expect(result?.content).toContain("Do the thing.");
		expect(result?.filePath).toBe("/path/to/SKILL.md");
	});

	test("returns null when name is missing", () => {
		const content = ["---", "description: A skill", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).toBeNull();
	});

	test("returns null when description is missing", () => {
		const content = ["---", "name: my-skill", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).toBeNull();
	});

	test("returns null when frontmatter is missing entirely", () => {
		const content = "# Just markdown\n\nNo frontmatter here.";
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).toBeNull();
	});

	test("silently ignores unknown frontmatter fields", () => {
		const content = [
			"---",
			"name: test-skill",
			"description: Test",
			"triggers:",
			"  - some trigger",
			"custom_field: value",
			"---",
			"Body content",
		].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("test-skill");
	});

	test("returns null for malformed YAML that throws", () => {
		const content = "---\ninvalid: [yaml: {{broken\n---\nBody";
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).toBeNull();
	});

	test("trims whitespace from name and description", () => {
		const content = ["---", "name: '  spaced-name  '", "description: '  spaced desc  '", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("spaced-name");
		expect(result?.description).toBe("spaced desc");
	});
});

describe("discoverSkills", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-skill-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("discovers skills from a single directory", () => {
		const skillDir = path.join(tmpDir, "skills", "my-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: my-skill", "description: A skill", "---", "Content"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "skills")]);
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("my-skill")).not.toBeUndefined();
		expect(registry.get("my-skill")?.description).toBe("A skill");
	});

	test("later directory overrides earlier by name", () => {
		const dir1 = path.join(tmpDir, "global", "tdd");
		const dir2 = path.join(tmpDir, "project", "tdd");
		fs.mkdirSync(dir1, { recursive: true });
		fs.mkdirSync(dir2, { recursive: true });
		fs.writeFileSync(
			path.join(dir1, "SKILL.md"),
			["---", "name: tdd", "description: Global TDD", "---", "Global body"].join("\n"),
		);
		fs.writeFileSync(
			path.join(dir2, "SKILL.md"),
			["---", "name: tdd", "description: Project TDD", "---", "Project body"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "global"), path.join(tmpDir, "project")]);
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("tdd")?.description).toBe("Project TDD");
		expect(registry.get("tdd")?.content).toContain("Project body");
	});

	test("discovers nested skills sorted by path", () => {
		const skillA = path.join(tmpDir, "skills", "a-first");
		const skillB = path.join(tmpDir, "skills", "subdir", "b-second");
		fs.mkdirSync(skillA, { recursive: true });
		fs.mkdirSync(skillB, { recursive: true });
		fs.writeFileSync(path.join(skillA, "SKILL.md"), ["---", "name: a-first", "description: First", "---", "A"].join("\n"));
		fs.writeFileSync(path.join(skillB, "SKILL.md"), ["---", "name: b-second", "description: Second", "---", "B"].join("\n"));
		const registry = discoverSkills([path.join(tmpDir, "skills")]);
		const names = registry.list().map((s) => s.name);
		expect(names).toContain("a-first");
		expect(names).toContain("b-second");
	});

	test("skips directories that do not exist", () => {
		const registry = discoverSkills(["/nonexistent/path/that/does/not/exist"]);
		expect(registry.list()).toHaveLength(0);
	});

	test("skips files with invalid frontmatter", () => {
		const skillDir = path.join(tmpDir, "skills", "bad");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), "No frontmatter at all");
		const registry = discoverSkills([path.join(tmpDir, "skills")]);
		expect(registry.list()).toHaveLength(0);
	});

	test("returns empty registry for empty directories list", () => {
		const registry = discoverSkills([]);
		expect(registry.list()).toHaveLength(0);
	});
});
