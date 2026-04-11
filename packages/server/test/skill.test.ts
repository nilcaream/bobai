import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuiltinSkillSource } from "../src/skill/builtin";
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

	test("parses mode field when present", () => {
		const content = ["---", "name: debug-skill", "description: A debug skill", "mode: debug", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("debug");
	});

	test("mode is undefined when not present", () => {
		const content = ["---", "name: normal-skill", "description: A normal skill", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.mode).toBeUndefined();
	});

	test("ignores invalid mode value", () => {
		const content = ["---", "name: bad-mode", "description: A skill", "mode: 123", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.mode).toBeUndefined();
	});

	test("ignores unrecognized mode string", () => {
		const content = ["---", "name: unknown-mode", "description: A skill", "mode: foobar", "---", "Body"].join("\n");
		const result = parseSkillFile(content, "/test/SKILL.md");
		expect(result).not.toBeNull();
		expect(result?.mode).toBeUndefined();
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

	test("discovers skills through symlinked directories", () => {
		// Create the actual skill outside the scan root
		const externalDir = path.join(tmpDir, "external", "my-skill");
		fs.mkdirSync(externalDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalDir, "SKILL.md"),
			["---", "name: linked-skill", "description: A symlinked skill", "---", "Linked content"].join("\n"),
		);

		// Symlink into the skills directory
		const skillsDir = path.join(tmpDir, "skills");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.symlinkSync(externalDir, path.join(skillsDir, "my-skill"));

		const registry = discoverSkills([skillsDir]);
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("linked-skill")).not.toBeUndefined();
		expect(registry.get("linked-skill")?.description).toBe("A symlinked skill");
		expect(registry.get("linked-skill")?.content).toContain("Linked content");
	});

	test("discovers skills through nested symlinked directories", () => {
		// Create a whole skill collection outside the scan root
		const externalBase = path.join(tmpDir, "external-collection");
		const skillA = path.join(externalBase, "skill-a");
		const skillB = path.join(externalBase, "group", "skill-b");
		fs.mkdirSync(skillA, { recursive: true });
		fs.mkdirSync(skillB, { recursive: true });
		fs.writeFileSync(path.join(skillA, "SKILL.md"), ["---", "name: skill-a", "description: First", "---", "A"].join("\n"));
		fs.writeFileSync(path.join(skillB, "SKILL.md"), ["---", "name: skill-b", "description: Second", "---", "B"].join("\n"));

		// Symlink the entire collection into the skills directory
		const skillsDir = path.join(tmpDir, "skills");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.symlinkSync(externalBase, path.join(skillsDir, "collection"));

		const registry = discoverSkills([skillsDir]);
		const names = registry.list().map((s) => s.name);
		expect(names).toContain("skill-a");
		expect(names).toContain("skill-b");
	});

	test("excludes debug-mode skills when debug is false", () => {
		const skillDir = path.join(tmpDir, "skills", "debug-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: debug-only", "description: A debug skill", "mode: debug", "---", "Debug content"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "skills")]);
		expect(registry.list()).toHaveLength(0);
	});

	test("includes debug-mode skills when debug is true", () => {
		const skillDir = path.join(tmpDir, "skills", "debug-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: debug-only", "description: A debug skill", "mode: debug", "---", "Debug content"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "skills")], { debug: true });
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("debug-only")).not.toBeUndefined();
	});

	test("includes skills without mode regardless of debug flag", () => {
		const skillDir = path.join(tmpDir, "skills", "normal-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: normal", "description: A normal skill", "---", "Normal content"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "skills")], { debug: false });
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("normal")).not.toBeUndefined();
	});

	test("registers built-in skills", () => {
		const builtinSkills: BuiltinSkillSource[] = [
			{
				raw: ["---", "name: builtin-skill", "description: A built-in skill", "---", "Built-in content"].join("\n"),
				relativePath: "skills/builtin-skill/SKILL.md",
			},
		];
		const registry = discoverSkills([], { builtinSkills });
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("builtin-skill")?.description).toBe("A built-in skill");
		expect(registry.get("builtin-skill")?.filePath).toBe("<builtin>/skills/builtin-skill/SKILL.md");
	});

	test("directory skills override built-in skills by name", () => {
		const builtinSkills: BuiltinSkillSource[] = [
			{
				raw: ["---", "name: override-me", "description: Built-in version", "---", "Built-in body"].join("\n"),
				relativePath: "skills/override-me/SKILL.md",
			},
		];
		const skillDir = path.join(tmpDir, "skills", "override-me");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: override-me", "description: Directory version", "---", "Directory body"].join("\n"),
		);
		const registry = discoverSkills([path.join(tmpDir, "skills")], { builtinSkills });
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("override-me")?.description).toBe("Directory version");
		expect(registry.get("override-me")?.content).toContain("Directory body");
	});

	test("filters debug-mode built-in skills when debug is false", () => {
		const builtinSkills: BuiltinSkillSource[] = [
			{
				raw: ["---", "name: debug-builtin", "description: Debug built-in", "mode: debug", "---", "Debug content"].join("\n"),
				relativePath: "skills/debug-builtin/SKILL.md",
			},
		];
		const registry = discoverSkills([], { builtinSkills });
		expect(registry.list()).toHaveLength(0);
	});

	test("includes debug-mode built-in skills when debug is true", () => {
		const builtinSkills: BuiltinSkillSource[] = [
			{
				raw: ["---", "name: debug-builtin", "description: Debug built-in", "mode: debug", "---", "Debug content"].join("\n"),
				relativePath: "skills/debug-builtin/SKILL.md",
			},
		];
		const registry = discoverSkills([], { debug: true, builtinSkills });
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("debug-builtin")).not.toBeUndefined();
	});
});
