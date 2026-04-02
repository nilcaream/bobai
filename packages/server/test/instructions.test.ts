import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInstructions } from "../src/instructions";

describe("loadInstructions", () => {
	let tmpDir: string;
	let globalConfigDir: string;
	let projectRoot: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-instructions-test-"));
		globalConfigDir = path.join(tmpDir, "config");
		projectRoot = path.join(tmpDir, "project");
		fs.mkdirSync(globalConfigDir, { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".bobai"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns empty array when no instruction files exist", () => {
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toEqual([]);
	});

	test("loads global AGENT.md as bobai-global type", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-global");
		expect(result[0].content).toBe("Global instructions here");
		expect(result[0].source).toBe(path.join(globalConfigDir, "AGENT.md"));
	});

	test("loads project .bobai/AGENT.md as bobai-project type", () => {
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Project instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-project");
		expect(result[0].content).toBe("Project instructions here");
		expect(result[0].source).toBe(path.join(projectRoot, ".bobai", "AGENT.md"));
	});

	test("loads both bobai files when both exist, global first", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global rules");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Project rules");
		const result = loadInstructions(globalConfigDir, projectRoot);
		const bobaiResults = result.filter((r) => r.type === "bobai-global" || r.type === "bobai-project");
		expect(bobaiResults).toHaveLength(2);
		expect(bobaiResults[0].type).toBe("bobai-global");
		expect(bobaiResults[0].content).toBe("Global rules");
		expect(bobaiResults[1].type).toBe("bobai-project");
		expect(bobaiResults[1].content).toBe("Project rules");
	});

	test("skips files that are empty or whitespace-only", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "   \n  \n  ");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Real content");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-project");
	});

	test("trims whitespace from file contents", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "\n  Instructions with whitespace  \n\n");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("Instructions with whitespace");
	});

	test("handles non-existent config directory gracefully", () => {
		const result = loadInstructions("/nonexistent/path", "/also/nonexistent");
		expect(result).toEqual([]);
	});

	// --- Project-specific context files (project root) ---

	test("loads AGENT.md from project root as project-specific type", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Project agent instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Project agent instructions");
		expect(result[0].source).toBe(path.join(projectRoot, "AGENT.md"));
	});

	test("loads AGENTS.md from project root as project-specific type", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Multi-agent instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Multi-agent instructions");
		expect(result[0].source).toBe(path.join(projectRoot, "AGENTS.md"));
	});

	test("loads CLAUDE.md from project root as project-specific type", () => {
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Claude-specific instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Claude-specific instructions");
		expect(result[0].source).toBe(path.join(projectRoot, "CLAUDE.md"));
	});

	test("loads all three project-specific files when all exist", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Agent content");
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Agents content");
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Claude content");
		const result = loadInstructions(globalConfigDir, projectRoot);
		const projectSpecific = result.filter((r) => r.type === "project-specific");
		expect(projectSpecific).toHaveLength(3);
		expect(projectSpecific[0].content).toBe("Agent content");
		expect(projectSpecific[1].content).toBe("Agents content");
		expect(projectSpecific[2].content).toBe("Claude content");
	});

	test("ordering is bobai-global, bobai-project, then project-specific files", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "BobAI project");
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Project root agent");
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Project root claude");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(4);
		expect(result[0].type).toBe("bobai-global");
		expect(result[1].type).toBe("bobai-project");
		expect(result[2].type).toBe("project-specific");
		expect(result[3].type).toBe("project-specific");
	});

	test("skips empty or whitespace-only project-specific files", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "  \n  ");
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Real agents content");
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Real agents content");
	});
});
