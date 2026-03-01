import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirectoryTool } from "../src/tool/list-directory";
import type { ToolContext } from "../src/tool/tool";

describe("listDirectoryTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-list-dir-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "file-a.txt"), "a");
		fs.writeFileSync(path.join(tmpDir, "file-b.txt"), "b");
		fs.mkdirSync(path.join(tmpDir, "subdir"));
		fs.writeFileSync(path.join(tmpDir, "subdir", "child.txt"), "c");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(listDirectoryTool.definition.function.name).toBe("list_directory");
	});

	test("lists project root when path is '.'", async () => {
		const result = await listDirectoryTool.execute({ path: "." }, ctx);
		expect(result.isError).toBeFalsy();
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.txt");
		expect(lines).toContain("file-b.txt");
		expect(lines).toContain("subdir/");
	});

	test("lists subdirectory contents", async () => {
		const result = await listDirectoryTool.execute({ path: "subdir" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("child.txt");
	});

	test("returns split llmOutput/uiOutput with mergeable flag", async () => {
		const result = await listDirectoryTool.execute({ path: "." }, ctx);
		expect(result.llmOutput).toContain("file-a.txt");
		expect(result.uiOutput).toBe("▸ Listing . (3 entries)");
		expect(result.mergeable).toBe(true);
	});

	test("returns error for nonexistent directory", async () => {
		const result = await listDirectoryTool.execute({ path: "nope" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.llmOutput).toContain("nope");
	});

	test("returns error for path traversal", async () => {
		const result = await listDirectoryTool.execute({ path: "../../" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.llmOutput).toContain("outside");
	});

	test("returns error when path is a file, not a directory", async () => {
		const result = await listDirectoryTool.execute({ path: "file-a.txt" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.llmOutput).toContain("not a directory");
	});

	test("defaults to project root when path is omitted", async () => {
		const result = await listDirectoryTool.execute({}, ctx);
		expect(result.isError).toBeFalsy();
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.txt");
	});
});
