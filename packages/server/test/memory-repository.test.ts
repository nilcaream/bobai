import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	createMemory,
	deleteMemory,
	ensureMemoriesSchema,
	findMemoryByTitle,
	getMemory,
	isMemoryType,
	listMemories,
	searchMemories,
	updateMemory,
} from "../src/memory/repository";

describe("memory repository", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureMemoriesSchema(db);
	});

	test("ensureMemoriesSchema creates memories table and type index", () => {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").all();
		expect(tables).toHaveLength(1);
		const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_type'").all();
		expect(indexes).toHaveLength(1);
	});

	test("ensureMemoriesSchema is idempotent", () => {
		ensureMemoriesSchema(db);
		ensureMemoriesSchema(db);
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").all();
		expect(tables).toHaveLength(1);
	});

	test("isMemoryType validates the closed taxonomy", () => {
		expect(isMemoryType("user")).toBe(true);
		expect(isMemoryType("feedback")).toBe(true);
		expect(isMemoryType("project")).toBe(true);
		expect(isMemoryType("reference")).toBe(true);
		expect(isMemoryType("other")).toBe(false);
		expect(isMemoryType(42)).toBe(false);
		expect(isMemoryType(null)).toBe(false);
	});

	test("createMemory returns a persisted memory with timestamps", () => {
		const memory = createMemory(db, {
			type: "feedback",
			title: "Use real DB in tests",
			description: "Integration tests must hit a real database",
			content: "Do not mock the database.",
			sessionId: "sess-1",
		});
		expect(memory.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(memory.type).toBe("feedback");
		expect(memory.sessionId).toBe("sess-1");
		expect(memory.createdAt).toBe(memory.updatedAt);
		expect(new Date(memory.createdAt).getTime()).toBeGreaterThan(0);
		expect(getMemory(db, memory.id)).toEqual(memory);
	});

	test("createMemory defaults description and sessionId to null", () => {
		const memory = createMemory(db, { type: "user", title: "Prefers pnpm", content: "Use pnpm, not npm." });
		expect(memory.description).toBeNull();
		expect(memory.sessionId).toBeNull();
	});

	test("listMemories returns all memories newest first", () => {
		createMemory(db, { type: "project", title: "A", content: "a" });
		createMemory(db, { type: "project", title: "B", content: "b" });

		// Force distinct updated_at values so ordering is deterministic.
		db.prepare("UPDATE memories SET updated_at = '2000-01-01T00:00:00.000Z' WHERE title = 'A'").run();
		db.prepare("UPDATE memories SET updated_at = '2001-01-01T00:00:00.000Z' WHERE title = 'B'").run();

		const all = listMemories(db);
		expect(all.map((m) => m.title)).toEqual(["B", "A"]);
	});

	test("listMemories filters by type", () => {
		createMemory(db, { type: "user", title: "u", content: "1" });
		createMemory(db, { type: "project", title: "p", content: "2" });
		createMemory(db, { type: "project", title: "q", content: "3" });

		const projects = listMemories(db, { type: "project" });
		expect(projects).toHaveLength(2);
		expect(projects.every((m) => m.type === "project")).toBe(true);
	});

	test("getMemory returns null for unknown id", () => {
		expect(getMemory(db, "nope")).toBeNull();
	});

	test("findMemoryByTitle matches case-insensitively", () => {
		createMemory(db, { type: "project", title: "Build Command", content: "bun run check" });
		expect(findMemoryByTitle(db, "build command")?.title).toBe("Build Command");
		expect(findMemoryByTitle(db, "BUILD COMMAND")?.title).toBe("Build Command");
		expect(findMemoryByTitle(db, "nonexistent")).toBeNull();
	});

	test("updateMemory updates fields and bumps updated_at", () => {
		const memory = createMemory(db, { type: "project", title: "Old", content: "old content" });
		db.prepare("UPDATE memories SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(memory.id);

		const updated = updateMemory(db, memory.id, { title: "New", content: "new content" });
		expect(updated).not.toBeNull();
		expect(updated?.title).toBe("New");
		expect(updated?.content).toBe("new content");
		expect(updated?.type).toBe("project"); // untouched field preserved
		expect(updated?.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
	});

	test("updateMemory clears description when patch description is null", () => {
		const memory = createMemory(db, {
			type: "project",
			title: "T",
			description: "old summary",
			content: "c",
		});
		const updated = updateMemory(db, memory.id, { description: null });
		expect(updated?.description).toBeNull();
	});

	test("updateMemory keeps description when patch omits it", () => {
		const memory = createMemory(db, {
			type: "project",
			title: "T",
			description: "keep me",
			content: "c",
		});
		const updated = updateMemory(db, memory.id, { content: "new c" });
		expect(updated?.description).toBe("keep me");
	});

	test("updateMemory returns null for unknown id", () => {
		expect(updateMemory(db, "nope", { title: "x" })).toBeNull();
	});

	test("deleteMemory removes the row and reports success", () => {
		const memory = createMemory(db, { type: "project", title: "T", content: "c" });
		expect(deleteMemory(db, memory.id)).toBe(true);
		expect(getMemory(db, memory.id)).toBeNull();
		expect(deleteMemory(db, memory.id)).toBe(false);
	});

	test("searchMemories matches title, description, and content", () => {
		createMemory(db, { type: "project", title: "Title hit", content: "x" });
		createMemory(db, { type: "project", title: "y", description: "desc hit", content: "z" });
		createMemory(db, { type: "project", title: "z", content: "content hit" });
		createMemory(db, { type: "project", title: "unrelated", content: "nothing" });

		expect(searchMemories(db, "hit")).toHaveLength(3);
		expect(searchMemories(db, "missing")).toHaveLength(0);
	});
});
