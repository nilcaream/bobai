import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initProject } from "../src/project";

describe("initProject", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("creates .bobai directory on first run", async () => {
		await initProject(tmpDir);
		expect(fs.existsSync(path.join(tmpDir, ".bobai"))).toBe(true);
	});

	test("creates project.json with a valid UUID on first run", async () => {
		await initProject(tmpDir);
		const raw = fs.readFileSync(path.join(tmpDir, ".bobai", "project.json"), "utf8");
		const json = JSON.parse(raw) as { id: string };
		expect(json.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test("reuses existing UUID on second run", async () => {
		const first = await initProject(tmpDir);
		const second = await initProject(tmpDir);
		expect(second.id).toBe(first.id);
	});

	test("creates bobai.db SQLite file", async () => {
		await initProject(tmpDir);
		expect(fs.existsSync(path.join(tmpDir, ".bobai", "bobai.db"))).toBe(true);
	});

	test("returns project id", async () => {
		const project = await initProject(tmpDir);
		expect(typeof project.id).toBe("string");
		expect(project.id.length).toBeGreaterThan(0);
	});
});
