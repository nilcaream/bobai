import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { sqlite3Tool } from "../src/tool/sqlite3";
import type { ToolContext } from "../src/tool/tool";

/** Assert an optional method exists and return it. */
function requireCompact(tool: typeof sqlite3Tool): NonNullable<typeof tool.compact> {
	if (!tool.compact) throw new Error("expected compact to be defined");
	return tool.compact;
}

describe("sqlite3Tool", () => {
	let tmpDir: string;
	let ctx: ToolContext;
	let dbPath: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-sqlite3-"));
		ctx = { projectRoot: tmpDir, sessionId: "test-session" };

		// Create a test database with sample data
		dbPath = path.join(tmpDir, "test.db");
		const db = new Database(dbPath, { create: true });
		db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
		db.exec("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')");
		db.exec("INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')");
		db.exec("INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')");
		db.close();
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(sqlite3Tool.definition.function.name).toBe("sqlite3");
	});

	test("executes a SELECT query and returns formatted table", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECT * FROM users" }, ctx);
		expect(result.llmOutput).toContain("| id | name | email |");
		expect(result.llmOutput).toContain("| --- | --- | --- |");
		expect(result.llmOutput).toContain("Alice");
		expect(result.llmOutput).toContain("Bob");
		expect(result.llmOutput).toContain("Charlie");
		expect(result.summary).toBe("3 rows");
	});

	test("returns empty result set for SELECT with no matches", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECT * FROM users WHERE id = 999" }, ctx);
		expect(result.llmOutput).toContain("(empty result set)");
		expect(result.summary).toBe("0 rows");
	});

	test("executes CREATE TABLE and returns changes summary", async () => {
		const newDb = path.join(tmpDir, "write-test.db");
		// Ensure it doesn't exist yet — the tool should create it
		expect(fs.existsSync(newDb)).toBe(false);

		const result = await sqlite3Tool.execute(
			{ database: "write-test.db", query: "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)" },
			ctx,
		);
		expect(result.llmOutput).toContain("Query executed successfully");
		expect(fs.existsSync(newDb)).toBe(true);
	});

	test("executes INSERT and reports rows affected", async () => {
		const result = await sqlite3Tool.execute(
			{ database: "write-test.db", query: "INSERT INTO items (label) VALUES ('one'), ('two'), ('three')" },
			ctx,
		);
		expect(result.llmOutput).toContain("Rows affected: 3");
	});

	test("executes PRAGMA as a read query", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "PRAGMA table_info(users)" }, ctx);
		expect(result.llmOutput).toContain("name");
		expect(result.llmOutput).toContain("id");
	});

	test("returns error for missing database arg", async () => {
		const result = await sqlite3Tool.execute({ query: "SELECT 1" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("database");
	});

	test("returns error for missing query arg", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("query");
	});

	test("returns error for empty database string", async () => {
		const result = await sqlite3Tool.execute({ database: "", query: "SELECT 1" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("database");
	});

	test("returns error for empty query string", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("query");
	});

	test("rejects paths outside project root", async () => {
		const result = await sqlite3Tool.execute({ database: "../../../etc/passwd", query: "SELECT 1" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("outside the project root");
	});

	test("handles SQL syntax errors gracefully", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECTT * FORM users" }, ctx);
		expect(result.llmOutput).toContain("Error");
	});

	test("handles querying a non-existent table gracefully", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECT * FROM nonexistent" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("nonexistent");
	});

	test("formatCall shows database and truncated query", () => {
		const short = sqlite3Tool.formatCall({ database: "app.db", query: "SELECT * FROM users" });
		expect(short).toBe("`sqlite3 app.db` → `SELECT * FROM users`");

		const longQuery = `SELECT ${"a, ".repeat(50)}z FROM very_long_table WHERE condition = true`;
		const long = sqlite3Tool.formatCall({ database: "app.db", query: longQuery });
		expect(long).toContain("...");
		expect(long.length).toBeLessThan(120);
	});

	test("compact() preserves small output", () => {
		const compact = requireCompact(sqlite3Tool);
		const small = "| id |\n| --- |\n| 1 |";
		expect(compact(small, { database: "db", query: "q" })).toBe(small);
	});

	test("compact() compresses large output keeping head and tail", () => {
		const compact = requireCompact(sqlite3Tool);
		const lines = Array.from({ length: 50 }, (_, i) => `| row ${i} |`);
		const output = lines.join("\n");
		const result = compact(output, { database: "test.db", query: "SELECT * FROM big" });
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("row 0");
		expect(result).toContain("row 49");
		expect(result).toContain("30 rows");
	});

	test("compact() preserves error output", () => {
		const compact = requireCompact(sqlite3Tool);
		const error = "Error: no such table: foo";
		expect(compact(error, { database: "db", query: "q" })).toBe(error);
	});

	test("summary reports singular row correctly", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECT * FROM users WHERE id = 1" }, ctx);
		expect(result.summary).toBe("1 row");
	});

	test("uiOutput contains SQL and results", async () => {
		const result = await sqlite3Tool.execute({ database: "test.db", query: "SELECT * FROM users" }, ctx);
		expect(result.uiOutput).toContain("sqlite3 test.db");
		expect(result.uiOutput).toContain("SELECT * FROM users");
		expect(result.uiOutput).toContain("Alice");
	});
});
