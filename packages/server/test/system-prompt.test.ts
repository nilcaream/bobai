import { describe, expect, test } from "bun:test";
import type { InstructionFile } from "../src/instructions";
import type { Skill } from "../src/skill/skill";
import { buildSystemPrompt, type SystemPromptDebug, type SystemPromptMetadata } from "../src/system-prompt";

describe("buildSystemPrompt", () => {
	test("wraps base prompt in <base> tags", () => {
		const result = buildSystemPrompt([]);
		expect(result).toStartWith("<base>\n");
		expect(result).toContain("\n</base>");
	});

	test("returns only base section when no skills or instructions provided", () => {
		const result = buildSystemPrompt([]);
		expect(result).toStartWith("<base>\n");
		expect(result).toEndWith("\n</base>");
		// No sections beyond <base>
		const afterBase = result.slice(result.indexOf("</base>") + "</base>".length);
		expect(afterBase).toBe("");
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

	test("wraps bobai-global instructions without source attribute", () => {
		const instructions: InstructionFile[] = [
			{ type: "bobai-global", source: "/home/user/.config/bobai/AGENT.md", content: "Always use TDD." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain('<instructions type="bobai-global">');
		expect(result).not.toContain("source=");
		expect(result).toContain("Always use TDD.");
		expect(result).toContain("</instructions>");
	});

	test("wraps bobai-project instructions without source attribute", () => {
		const instructions: InstructionFile[] = [
			{ type: "bobai-project", source: "/project/.bobai/AGENT.md", content: "Project overrides." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain('<instructions type="bobai-project">');
		expect(result).not.toContain("source=");
		expect(result).toContain("Project overrides.");
		expect(result).toContain("</instructions>");
	});

	test("wraps project-specific instructions with source attribute showing filename", () => {
		const instructions: InstructionFile[] = [
			{ type: "project-specific", source: "/project/AGENT.md", content: "Agent conventions." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain('<instructions type="project-specific" source="AGENT.md">');
		expect(result).toContain("Agent conventions.");
		expect(result).toContain("</instructions>");
	});

	test("multiple project-specific instructions each get their own source attribute", () => {
		const instructions: InstructionFile[] = [
			{ type: "project-specific", source: "/project/AGENT.md", content: "Agent stuff." },
			{ type: "project-specific", source: "/project/CLAUDE.md", content: "Claude stuff." },
		];
		const result = buildSystemPrompt([], instructions);
		expect(result).toContain('<instructions type="project-specific" source="AGENT.md">');
		expect(result).toContain('<instructions type="project-specific" source="CLAUDE.md">');
		expect(result).toContain("Agent stuff.");
		expect(result).toContain("Claude stuff.");
	});

	test("appends multiple instruction sections in order", () => {
		const instructions: InstructionFile[] = [
			{ type: "bobai-global", source: "/global/AGENT.md", content: "Global rules." },
			{ type: "bobai-project", source: "/project/.bobai/AGENT.md", content: "Project rules." },
			{ type: "project-specific", source: "/project/AGENT.md", content: "Shared conventions." },
		];
		const result = buildSystemPrompt([], instructions);
		// Search after </base> to avoid matching the literal text in the base prompt description
		const afterBase = result.indexOf("</base>");
		const globalIdx = result.indexOf('<instructions type="bobai-global"', afterBase);
		const projectIdx = result.indexOf('<instructions type="bobai-project"', afterBase);
		const specificIdx = result.indexOf('<instructions type="project-specific"', afterBase);
		expect(globalIdx).toBeGreaterThan(-1);
		expect(projectIdx).toBeGreaterThan(globalIdx);
		expect(specificIdx).toBeGreaterThan(projectIdx);
	});

	test("skills appear before instructions", () => {
		const instructions: InstructionFile[] = [{ type: "bobai-global", source: "/global/AGENT.md", content: "Be helpful." }];
		const skills: Skill[] = [{ name: "tdd", description: "Test-driven development", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills, instructions);
		const skillIdx = result.indexOf("<skills>");
		// Search after </base> to avoid matching the literal text in the base prompt description
		const afterBase = result.indexOf("</base>");
		const instructionIdx = result.indexOf("<instructions", afterBase);
		expect(skillIdx).toBeGreaterThan(-1);
		expect(instructionIdx).toBeGreaterThan(skillIdx);
	});

	test("returns only base section when instructions array is empty", () => {
		const result = buildSystemPrompt([], []);
		expect(result).toStartWith("<base>\n");
		expect(result).toEndWith("\n</base>");
		const afterBase = result.slice(result.indexOf("</base>") + "</base>".length);
		expect(afterBase).toBe("");
	});

	test("context compaction section uses plain label instead of markdown heading", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("Context Compaction:");
		expect(result).not.toContain("## Context Compaction");
	});

	// --- System prompt language about context files ---

	test("describes auto-injection of project-root context files", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("project-specific");
		expect(result).toContain("automatically included");
	});

	test("mentions README.md should be read on demand, not auto-injected", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("README.md");
		expect(result).toContain("not auto-injected");
	});

	test("mentions reading subdirectory context files on demand", () => {
		const result = buildSystemPrompt([]);
		expect(result).toContain("subdirector");
	});

	// --- Subagent system prompt ---

	test("subagent prompt excludes task tool from tool list", () => {
		const result = buildSystemPrompt([], [], { subagent: true });
		// Should not list task as an available tool
		expect(result).not.toContain("- task:");
		// Should not mention delegating to subagents in the guidance
		expect(result).not.toContain("Use the task tool");
	});

	test("subagent prompt includes all other tools", () => {
		const result = buildSystemPrompt([], [], { subagent: true });
		expect(result).toContain("- read_file:");
		expect(result).toContain("- list_directory:");
		expect(result).toContain("- write_file:");
		expect(result).toContain("- edit_file:");
		expect(result).toContain("- grep_search:");
		expect(result).toContain("- bash:");
		expect(result).toContain("- sqlite3:");
		expect(result).toContain("- skill:");
	});

	test("subagent prompt includes subagent context note", () => {
		const result = buildSystemPrompt([], [], { subagent: true });
		expect(result).toContain("running as a subagent");
		expect(result).toContain("task");
		expect(result).toContain("not available in this context");
	});

	test("parent prompt does not include subagent context note", () => {
		const result = buildSystemPrompt([]);
		expect(result).not.toContain("running as a subagent");
	});

	test("subagent prompt still includes skills and instructions", () => {
		const skills: Skill[] = [
			{ name: "debugging", description: "Systematic debugging", content: "...", filePath: "/a/SKILL.md" },
		];
		const instructions: InstructionFile[] = [{ type: "bobai-global", source: "/global/AGENT.md", content: "Be helpful." }];
		const result = buildSystemPrompt(skills, instructions, { subagent: true });
		expect(result).toContain("- **debugging**: Systematic debugging");
		expect(result).toContain("Be helpful.");
	});

	// --- Metadata block ---

	test("metadata block is included when metadata is provided", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
			gitBranch: "main",
		};
		const result = buildSystemPrompt([], [], { metadata });
		expect(result).toContain("<metadata>");
		expect(result).toContain("</metadata>");
		expect(result).toContain("- Date: 2025-07-14 Mon 14:32 UTC+2");
		expect(result).toContain("- Project: /home/user/projects/bobai");
		expect(result).toContain("- Branch: main");
	});

	test("metadata block is omitted when metadata is not provided", () => {
		const result = buildSystemPrompt([], []);
		expect(result).not.toContain("<metadata>");
		expect(result).not.toContain("</metadata>");
	});

	test("metadata block omits branch line when gitBranch is undefined", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
		};
		const result = buildSystemPrompt([], [], { metadata });
		expect(result).toContain("- Date: 2025-07-14 Mon 14:32 UTC+2");
		expect(result).toContain("- Project: /home/user/projects/bobai");
		expect(result).not.toContain("- Branch:");
	});

	test("metadata block appears after base and before skills", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
			gitBranch: "main",
		};
		const skills: Skill[] = [{ name: "tdd", description: "Test-driven development", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills, [], { metadata });
		const baseIdx = result.indexOf("</base>");
		const metadataIdx = result.indexOf("<metadata>");
		const skillsIdx = result.indexOf("<skills>");
		expect(metadataIdx).toBeGreaterThan(baseIdx);
		expect(skillsIdx).toBeGreaterThan(metadataIdx);
	});

	test("metadata block appears after base and before instructions when no skills", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
			gitBranch: "main",
		};
		const instructions: InstructionFile[] = [{ type: "bobai-global", source: "/global/AGENT.md", content: "Be helpful." }];
		const result = buildSystemPrompt([], instructions, { metadata });
		const baseIdx = result.indexOf("</base>");
		const metadataIdx = result.indexOf("<metadata>");
		// Search after </base> to avoid matching literal text in base prompt
		const afterBase = result.indexOf("</base>");
		const instructionIdx = result.indexOf("<instructions", afterBase);
		expect(metadataIdx).toBeGreaterThan(baseIdx);
		expect(instructionIdx).toBeGreaterThan(metadataIdx);
	});

	// --- Debug block ---

	test("debug block is included when debug metadata is provided", () => {
		const debug: SystemPromptDebug = {
			uptimeSeconds: 3642,
			sessionId: "abc-123-def",
		};
		const result = buildSystemPrompt([], [], { debug });
		expect(result).toContain("<debug>");
		expect(result).toContain("</debug>");
		expect(result).toContain("- Time since restart: 3642s");
		expect(result).toContain("- Bob AI parent session ID: abc-123-def");
	});

	test("debug block is omitted when debug is not provided", () => {
		const result = buildSystemPrompt([], []);
		expect(result).not.toContain("<debug>");
		expect(result).not.toContain("</debug>");
	});

	test("debug block appears after metadata and before skills", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
			gitBranch: "main",
		};
		const debug: SystemPromptDebug = {
			uptimeSeconds: 100,
			sessionId: "sess-001",
		};
		const skills: Skill[] = [{ name: "tdd", description: "Test-driven development", content: "...", filePath: "/a/SKILL.md" }];
		const result = buildSystemPrompt(skills, [], { metadata, debug });
		const metadataIdx = result.indexOf("<metadata>");
		const debugIdx = result.indexOf("<debug>");
		const skillsIdx = result.indexOf("<skills>");
		expect(debugIdx).toBeGreaterThan(metadataIdx);
		expect(skillsIdx).toBeGreaterThan(debugIdx);
	});

	test("subagent prompt includes metadata and debug blocks", () => {
		const metadata: SystemPromptMetadata = {
			date: "2025-07-14 Mon 14:32 UTC+2",
			projectDir: "/home/user/projects/bobai",
			gitBranch: "feature-x",
		};
		const debug: SystemPromptDebug = {
			uptimeSeconds: 999,
			sessionId: "sub-abc",
		};
		const result = buildSystemPrompt([], [], { subagent: true, metadata, debug });
		expect(result).toContain("<metadata>");
		expect(result).toContain("- Date: 2025-07-14 Mon 14:32 UTC+2");
		expect(result).toContain("- Project: /home/user/projects/bobai");
		expect(result).toContain("- Branch: feature-x");
		expect(result).toContain("</metadata>");
		expect(result).toContain("<debug>");
		expect(result).toContain("- Time since restart: 999s");
		expect(result).toContain("- Bob AI parent session ID: sub-abc");
		expect(result).toContain("</debug>");
	});
});
