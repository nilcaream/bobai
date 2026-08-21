import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createMemory, ensureMemoriesSchema, listMemories } from "../src/memory/repository";
import { createMemoryTool } from "../src/tool/memory";
import type { ToolContext } from "../src/tool/tool";

describe("memoryTool", () => {
	let db: Database;
	let ctx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		ensureMemoriesSchema(db);
		ctx = { projectRoot: "/tmp/project", sessionId: "sess-1" };
	});

	test("definition has the memory tool name", () => {
		const tool = createMemoryTool(db);
		expect(tool.definition.function.name).toBe("memory");
	});

	test("parent tool exposes all six commands", () => {
		const tool = createMemoryTool(db);
		const command = tool.definition.function.parameters.properties.command;
		expect(command.enum).toEqual(["list", "search", "get", "save", "update", "delete"]);
	});

	test("read-only tool exposes only read commands", () => {
		const tool = createMemoryTool(db, { readOnly: true });
		const command = tool.definition.function.parameters.properties.command;
		expect(command.enum).toEqual(["list", "search", "get"]);
		expect(tool.definition.function.description).toContain("read-only");
	});

	test("save creates a memory and list/get read it back", async () => {
		const tool = createMemoryTool(db);
		const saved = await tool.execute(
			{
				command: "save",
				type: "feedback",
				title: "Use real DB",
				content: "No mocks in tests.",
				description: "Integration tests",
			},
			ctx,
		);
		expect(saved.llmOutput).toContain("Saved memory");
		expect(saved.llmOutput).toContain("Use real DB");

		const list = await tool.execute({ command: "list" }, ctx);
		expect(list.llmOutput).toContain("[feedback] Use real DB");
		expect(list.llmOutput).toContain("Integration tests");

		const id = listMemories(db)[0]?.id as string;
		const got = await tool.execute({ command: "get", id }, ctx);
		expect(got.llmOutput).toContain("No mocks in tests.");
	});

	test("save upserts by title (case-insensitive)", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "Build Command", content: "bun run check" }, ctx);
		const result = await tool.execute(
			{ command: "save", type: "feedback", title: "build command", content: "bun run check --write" },
			ctx,
		);
		expect(result.llmOutput).toContain("Updated existing memory");
		expect(listMemories(db)).toHaveLength(1);
		expect(listMemories(db)[0]?.type).toBe("feedback");
		expect(listMemories(db)[0]?.content).toBe("bun run check --write");
	});

	test("list reports empty state", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "list" }, ctx);
		expect(result.llmOutput).toBe("No memories saved yet.");
	});

	test("list filters by type and rejects invalid types", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "user", title: "Prefers pnpm", content: "pnpm" }, ctx);
		await tool.execute({ command: "save", type: "project", title: "Architecture", content: "monorepo" }, ctx);

		const filtered = await tool.execute({ command: "list", type: "user" }, ctx);
		expect(filtered.llmOutput).toContain("Prefers pnpm");
		expect(filtered.llmOutput).not.toContain("Architecture");

		const invalid = await tool.execute({ command: "list", type: "bogus" }, ctx);
		expect(invalid.llmOutput).toContain("invalid type");
	});

	test("search matches keywords and reports no matches", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "Flaky endpoint", content: "GET /v1/users" }, ctx);

		const hit = await tool.execute({ command: "search", query: "flaky" }, ctx);
		expect(hit.llmOutput).toContain("Flaky endpoint");

		const miss = await tool.execute({ command: "search", query: "zzz" }, ctx);
		expect(miss.llmOutput).toContain("No memories match");
	});

	test("search requires a query", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "search" }, ctx);
		expect(result.llmOutput).toContain("query");
	});

	test("get resolves by unique id prefix", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "T", content: "body" }, ctx);
		const id = listMemories(db)[0]?.id as string;
		const got = await tool.execute({ command: "get", id: id.slice(0, 8) }, ctx);
		expect(got.llmOutput).toContain("body");
	});

	test("get returns an error for unknown id", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "get", id: "nope" }, ctx);
		expect(result.llmOutput).toContain("no memory found");
	});

	test("get requires an id", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "get" }, ctx);
		expect(result.llmOutput).toContain("id");
	});

	test("get reports ambiguity when id prefix matches multiple memories", async () => {
		const tool = createMemoryTool(db);
		const m1 = createMemory(db, { type: "project", title: "A", content: "a" });
		const m2 = createMemory(db, { type: "project", title: "B", content: "b" });
		db.prepare("UPDATE memories SET id = ? WHERE id = ?").run("prefix-aaaa", m1.id);
		db.prepare("UPDATE memories SET id = ? WHERE id = ?").run("prefix-bbbb", m2.id);

		const result = await tool.execute({ command: "get", id: "prefix" }, ctx);
		expect(result.llmOutput).toContain("ambiguous");
	});

	test("get includes a freshness caveat for old memories", async () => {
		const tool = createMemoryTool(db);
		const m = createMemory(db, { type: "project", title: "Old", content: "body" });
		db.prepare("UPDATE memories SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.id);

		const result = await tool.execute({ command: "get", id: m.id }, ctx);
		expect(result.llmOutput).toContain("point-in-time observations");
	});

	test("update edits fields and requires at least one field", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "Old", content: "old" }, ctx);
		const id = listMemories(db)[0]?.id as string;

		const updated = await tool.execute({ command: "update", id, content: "new content" }, ctx);
		expect(updated.llmOutput).toContain("Updated memory");

		const noFields = await tool.execute({ command: "update", id }, ctx);
		expect(noFields.llmOutput).toContain("at least one field");
	});

	test("update requires an id", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "update", content: "x" }, ctx);
		expect(result.llmOutput).toContain("id");
	});

	test("update rejects invalid type and empty title", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "T", content: "c" }, ctx);
		const id = listMemories(db)[0]?.id as string;

		const badType = await tool.execute({ command: "update", id, type: "bogus" }, ctx);
		expect(badType.llmOutput).toContain("type");

		const emptyTitle = await tool.execute({ command: "update", id, title: "   " }, ctx);
		expect(emptyTitle.llmOutput).toContain("title");
	});

	test("update clears description when passed an empty string", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "T", content: "c", description: "summary" }, ctx);
		const id = listMemories(db)[0]?.id as string;

		await tool.execute({ command: "update", id, description: "" }, ctx);
		expect(listMemories(db)[0]?.description).toBeNull();
	});

	test("update edits type and title in place", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "Old", content: "c" }, ctx);
		const id = listMemories(db)[0]?.id as string;

		await tool.execute({ command: "update", id, type: "user", title: "New" }, ctx);
		const memory = listMemories(db)[0];
		expect(memory?.type).toBe("user");
		expect(memory?.title).toBe("New");
	});

	test("delete removes a memory and errors on unknown id", async () => {
		const tool = createMemoryTool(db);
		await tool.execute({ command: "save", type: "project", title: "T", content: "c" }, ctx);
		const id = listMemories(db)[0]?.id as string;

		const deleted = await tool.execute({ command: "delete", id }, ctx);
		expect(deleted.llmOutput).toContain("Deleted memory");
		expect(listMemories(db)).toHaveLength(0);

		const again = await tool.execute({ command: "delete", id }, ctx);
		expect(again.llmOutput).toContain("no memory found");
	});

	test("delete requires an id", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "delete" }, ctx);
		expect(result.llmOutput).toContain("id");
	});

	test("save validates type, title, and content", async () => {
		const tool = createMemoryTool(db);
		const badType = await tool.execute({ command: "save", type: "bogus", title: "t", content: "c" }, ctx);
		expect(badType.llmOutput).toContain("type");

		const noTitle = await tool.execute({ command: "save", type: "user", content: "c" }, ctx);
		expect(noTitle.llmOutput).toContain("title");

		const noContent = await tool.execute({ command: "save", type: "user", title: "t" }, ctx);
		expect(noContent.llmOutput).toContain("content");
	});

	test("read-only tool rejects write commands with a report-to-main-agent message", async () => {
		const tool = createMemoryTool(db, { readOnly: true });
		for (const command of ["save", "update", "delete"]) {
			const result = await tool.execute(
				command === "save" ? { command, type: "user", title: "t", content: "c" } : { command, id: "x" },
				ctx,
			);
			expect(result.llmOutput).toContain("read-only");
			expect(result.llmOutput).toContain("report it in your final response");
		}
		expect(listMemories(db)).toHaveLength(0);
	});

	test("read-only tool still allows reads", async () => {
		// Seed via a write-capable tool first.
		const writer = createMemoryTool(db);
		await writer.execute({ command: "save", type: "project", title: "Shared", content: "body" }, ctx);

		const reader = createMemoryTool(db, { readOnly: true });
		const result = await reader.execute({ command: "list" }, ctx);
		expect(result.llmOutput).toContain("Shared");
	});

	test("unknown command returns an error listing valid commands", async () => {
		const tool = createMemoryTool(db);
		const result = await tool.execute({ command: "bogus" }, ctx);
		expect(result.llmOutput).toContain("unknown");
	});

	test("formatCall renders each command", () => {
		const tool = createMemoryTool(db);
		expect(tool.formatCall({ command: "list" })).toBe("▸ memory list");
		expect(tool.formatCall({ command: "search", query: "x" })).toBe('▸ memory search "x"');
		expect(tool.formatCall({ command: "get", id: "abc" })).toBe("▸ memory get abc");
		expect(tool.formatCall({ command: "save", title: "Title" })).toBe('▸ memory save "Title"');
		expect(tool.formatCall({ command: "delete", id: "abc" })).toBe("▸ memory delete abc");
	});
});
