import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

	test("creates bobai.json with a valid UUID on first run", async () => {
		await initProject(tmpDir);
		const raw = fs.readFileSync(path.join(tmpDir, ".bobai", "bobai.json"), "utf8");
		const json = JSON.parse(raw) as { id: string };
		expect(json.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test("generates and persists UUID when bobai.json exists but has no id", async () => {
		fs.mkdirSync(path.join(tmpDir, ".bobai"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".bobai", "bobai.json"), JSON.stringify({}));
		const project = await initProject(tmpDir);
		expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, ".bobai", "bobai.json"), "utf8")) as { id: string };
		expect(raw.id).toBe(project.id);
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

	test("creates sessions and messages tables", async () => {
		const project = await initProject(tmpDir);
		const tables = project.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
			name: string;
		}[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("sessions");
		expect(names).toContain("messages");

		const indexes = project.db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session'")
			.all();
		expect(indexes).toHaveLength(1);
	});

	test("migrates existing sessions table by adding provider and api_family columns", async () => {
		fs.mkdirSync(path.join(tmpDir, ".bobai"), { recursive: true });
		const dbFile = path.join(tmpDir, ".bobai", "bobai.db");
		const db = new Database(dbFile, { create: true });
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT,
				model TEXT,
				parent_id TEXT REFERENCES sessions(id),
				prompt_tokens INTEGER NOT NULL DEFAULT 0,
				prompt_chars INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at TEXT NOT NULL,
				sort_order INTEGER NOT NULL,
				metadata TEXT
			)
		`);
		db.close();

		const project = await initProject(tmpDir);
		const columns = project.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
		expect(columns.some((c) => c.name === "provider")).toBe(true);
		expect(columns.some((c) => c.name === "api_family")).toBe(true);
	});

	test("reads debug from bobai.json", async () => {
		fs.mkdirSync(path.join(tmpDir, ".bobai"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".bobai", "bobai.json"), JSON.stringify({ debug: true }));
		const project = await initProject(tmpDir);
		expect(project.debug).toBe(true);
	});

	test("reads maxIterations from bobai.json", async () => {
		fs.mkdirSync(path.join(tmpDir, ".bobai"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".bobai", "bobai.json"), JSON.stringify({ maxIterations: 60 }));
		const project = await initProject(tmpDir);
		expect(project.maxIterations).toBe(60);
	});
});
