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

	// --- bobai-global layer ---

	test("loads global AGENT.md as bobai-global type (sole file)", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-global");
		expect(result[0].content).toBe("Global instructions here");
		expect(result[0].source).toBe("AGENT.md");
	});

	test("combines multiple files in bobai-global layer in order: AGENT.md, AGENTS.md, CLAUDE.md", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENTS.md"), "Second file");
		fs.writeFileSync(path.join(globalConfigDir, "CLAUDE.md"), "Third file");
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "First file");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-global");
		expect(result[0].content).toBe("First file\n\nSecond file\n\nThird file");
		expect(result[0].source).toBe("AGENT.md, AGENTS.md, CLAUDE.md");
	});

	test("skips empty files in bobai-global layer, still loads valid ones", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "   \n  \n  ");
		fs.writeFileSync(path.join(globalConfigDir, "AGENTS.md"), "Real content");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-global");
		expect(result[0].content).toBe("Real content");
		expect(result[0].source).toBe("AGENTS.md");
	});

	// --- bobai-project layer (.bobai/) ---

	test("loads project .bobai/AGENT.md as bobai-project type (sole file)", () => {
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Project instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-project");
		expect(result[0].content).toBe("Project instructions here");
		expect(result[0].source).toBe("AGENT.md");
	});

	test("combines multiple files in bobai-project layer in order: AGENT.md, AGENTS.md, CLAUDE.md", () => {
		fs.writeFileSync(path.join(projectRoot, ".bobai", "CLAUDE.md"), "Claude in .bobai");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Agent in .bobai");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENTS.md"), "Agents in .bobai");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("bobai-project");
		expect(result[0].content).toBe("Agent in .bobai\n\nAgents in .bobai\n\nClaude in .bobai");
		expect(result[0].source).toBe("AGENT.md, AGENTS.md, CLAUDE.md");
	});

	// --- project-specific layer (project root) ---

	test("loads AGENT.md from project root as project-specific type (sole file)", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Project agent instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Project agent instructions");
		expect(result[0].source).toBe("AGENT.md");
	});

	test("loads AGENTS.md from project root as project-specific type (sole file)", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Multi-agent instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Multi-agent instructions");
		expect(result[0].source).toBe("AGENTS.md");
	});

	test("loads CLAUDE.md from project root as project-specific type (sole file)", () => {
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Claude-specific instructions");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Claude-specific instructions");
		expect(result[0].source).toBe("CLAUDE.md");
	});

	test("combines all three project-specific files into a single entry, in order", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Agent content");
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Agents content");
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Claude content");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Agent content\n\nAgents content\n\nClaude content");
		expect(result[0].source).toBe("AGENT.md, AGENTS.md, CLAUDE.md");
	});

	test("skips empty or whitespace-only project-specific files, loads the rest", () => {
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "  \n  ");
		fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Real agents content");
		fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project-specific");
		expect(result[0].content).toBe("Real agents content");
		expect(result[0].source).toBe("AGENTS.md");
	});

	// --- cross-layer ordering ---

	test("ordering is bobai-global, bobai-project, then project-specific", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "BobAI project");
		fs.writeFileSync(path.join(projectRoot, "AGENT.md"), "Project root agent");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(3);
		expect(result[0].type).toBe("bobai-global");
		expect(result[0].content).toBe("Global");
		expect(result[1].type).toBe("bobai-project");
		expect(result[1].content).toBe("BobAI project");
		expect(result[2].type).toBe("project-specific");
		expect(result[2].content).toBe("Project root agent");
	});

	test("handles non-existent directories gracefully", () => {
		const result = loadInstructions("/nonexistent/path", "/also/nonexistent");
		expect(result).toEqual([]);
	});

	// --- whitespace trimming ---

	test("trims whitespace from file contents", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "\n  Instructions with whitespace  \n\n");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("Instructions with whitespace");
	});
});
