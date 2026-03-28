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

	test("loads global AGENT.md when it exists", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("global");
		expect(result[0].content).toBe("Global instructions here");
		expect(result[0].source).toBe(path.join(globalConfigDir, "AGENT.md"));
	});

	test("loads project AGENT.md when it exists", () => {
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Project instructions here");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project");
		expect(result[0].content).toBe("Project instructions here");
		expect(result[0].source).toBe(path.join(projectRoot, ".bobai", "AGENT.md"));
	});

	test("loads both files when both exist, global first", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "Global rules");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Project rules");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe("global");
		expect(result[0].content).toBe("Global rules");
		expect(result[1].type).toBe("project");
		expect(result[1].content).toBe("Project rules");
	});

	test("skips files that are empty or whitespace-only", () => {
		fs.writeFileSync(path.join(globalConfigDir, "AGENT.md"), "   \n  \n  ");
		fs.writeFileSync(path.join(projectRoot, ".bobai", "AGENT.md"), "Real content");
		const result = loadInstructions(globalConfigDir, projectRoot);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("project");
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
});
