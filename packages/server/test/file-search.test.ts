import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSearchTool } from "../src/tool/file-search";
import type { ToolContext } from "../src/tool/tool";

describe("fileSearchTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-file-search-"));
		ctx = { projectRoot: tmpDir };

		// Create test file tree:
		// file-a.ts
		// file-b.ts
		// readme.md
		// src/
		//   index.ts
		//   utils.ts
		//   deep/
		//     helper.ts
		//     data.json
		fs.writeFileSync(path.join(tmpDir, "file-a.ts"), "a");
		fs.writeFileSync(path.join(tmpDir, "file-b.ts"), "b");
		fs.writeFileSync(path.join(tmpDir, "readme.md"), "# readme");
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "idx");
		fs.writeFileSync(path.join(tmpDir, "src", "utils.ts"), "util");
		fs.mkdirSync(path.join(tmpDir, "src", "deep"));
		fs.writeFileSync(path.join(tmpDir, "src", "deep", "helper.ts"), "help");
		fs.writeFileSync(path.join(tmpDir, "src", "deep", "data.json"), "{}");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(fileSearchTool.definition.function.name).toBe("file_search");
	});

	test("finds files matching a simple glob in project root", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.ts" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.ts");
		expect(lines).toContain("file-b.ts");
		// Should NOT include files in subdirectories (non-recursive glob)
		expect(lines).not.toContain("src/index.ts");
	});

	test("finds files recursively with ** pattern", async () => {
		const result = await fileSearchTool.execute({ pattern: "**/*.ts" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.ts");
		expect(lines).toContain("file-b.ts");
		expect(lines).toContain("src/index.ts");
		expect(lines).toContain("src/utils.ts");
		expect(lines).toContain("src/deep/helper.ts");
		// Should NOT include non-.ts files
		expect(lines).not.toContain("readme.md");
		expect(lines).not.toContain("src/deep/data.json");
	});

	test("returns only files, not directories", async () => {
		const result = await fileSearchTool.execute({ pattern: "**/*" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		// Directories should not appear
		expect(lines).not.toContain("src");
		expect(lines).not.toContain("src/");
		expect(lines).not.toContain("src/deep");
		expect(lines).not.toContain("src/deep/");
		// Files should appear
		expect(lines).toContain("file-a.ts");
		expect(lines).toContain("src/index.ts");
	});

	test("returns no-match message when nothing matches", async () => {
		const result = await fileSearchTool.execute({ pattern: "**/*.xyz" }, ctx);
		expect(result.llmOutput).toContain("No files found");
		expect(result.llmOutput).toContain("*.xyz");
	});

	test("defaults to project root when path is omitted", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.md" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("readme.md");
	});

	test("searches within specified subdirectory", async () => {
		const result = await fileSearchTool.execute({ pattern: "**/*.ts", path: "src" }, ctx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("index.ts");
		expect(lines).toContain("utils.ts");
		expect(lines).toContain("deep/helper.ts");
		// Files outside src/ should not appear
		expect(lines).not.toContain("file-a.ts");
		expect(lines).not.toContain("file-b.ts");
	});

	test("returns correct uiOutput format", async () => {
		const result = await fileSearchTool.execute({ pattern: "**/*.ts" }, ctx);
		expect(result.uiOutput).toMatch(/▸ Searching \\\*\\\*\/\\\*\.ts \(\d+ files found\)/);
	});

	test("returns correct formatCall format", () => {
		const formatted = fileSearchTool.formatCall({ pattern: "**/*.ts" });
		expect(formatted).toBe("▸ Searching \\*\\*/\\*.ts");
	});

	test("is always mergeable", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.ts" }, ctx);
		expect(result.mergeable).toBe(true);
		expect(fileSearchTool.mergeable).toBe(true);
	});

	test("returns error when pattern is missing", async () => {
		const result = await fileSearchTool.execute({}, ctx);
		expect(result.llmOutput).toContain("pattern");
		expect(result.llmOutput).toContain("required");
		expect(result.mergeable).toBe(true);
	});

	test("returns error when pattern is empty string", async () => {
		const result = await fileSearchTool.execute({ pattern: "" }, ctx);
		expect(result.llmOutput).toContain("pattern");
		expect(result.llmOutput).toContain("required");
		expect(result.mergeable).toBe(true);
	});

	test("returns error for path traversal outside project root", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.ts", path: "../../" }, ctx);
		expect(result.llmOutput).toContain("outside");
		expect(result.mergeable).toBe(true);
	});

	test("returns error when path does not exist", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.ts", path: "nonexistent" }, ctx);
		expect(result.llmOutput).toContain("not found");
		expect(result.mergeable).toBe(true);
	});

	test("returns error when path is a file, not a directory", async () => {
		const result = await fileSearchTool.execute({ pattern: "*.ts", path: "file-a.ts" }, ctx);
		expect(result.llmOutput).toContain("not a directory");
		expect(result.mergeable).toBe(true);
	});

	test("caps results at 1000 files", async () => {
		// Create a temporary directory with >1000 files
		const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-file-search-big-"));
		const bigCtx: ToolContext = { projectRoot: bigDir };
		for (let i = 0; i < 1010; i++) {
			fs.writeFileSync(path.join(bigDir, `file-${String(i).padStart(4, "0")}.txt`), "x");
		}

		const result = await fileSearchTool.execute({ pattern: "*.txt" }, bigCtx);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		// Last line should be the truncation notice, files should be capped
		expect(result.llmOutput).toContain("capped at 1000");
		// Should have at most 1000 file lines + truncation notice
		const fileLines = lines.filter((l) => !l.startsWith("("));
		expect(fileLines.length).toBe(1000);

		fs.rmSync(bigDir, { recursive: true, force: true });
	});

	test("allows searching in accessibleDirectories", async () => {
		const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-file-search-extra-"));
		fs.writeFileSync(path.join(extraDir, "extra.ts"), "e");
		const ctxWithExtra: ToolContext = { projectRoot: tmpDir, accessibleDirectories: [extraDir] };

		const result = await fileSearchTool.execute({ pattern: "*.ts", path: extraDir }, ctxWithExtra);
		const lines = result.llmOutput.split("\n").filter(Boolean);
		expect(lines).toContain("extra.ts");

		fs.rmSync(extraDir, { recursive: true, force: true });
	});

	test("rejects searching directories outside both projectRoot and accessibleDirectories", async () => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-file-search-outside-"));
		fs.writeFileSync(path.join(outsideDir, "secret.ts"), "s");
		const ctxWithEmpty: ToolContext = { projectRoot: tmpDir, accessibleDirectories: [] };

		const result = await fileSearchTool.execute({ pattern: "*.ts", path: outsideDir }, ctxWithEmpty);
		expect(result.llmOutput).toContain("outside");

		fs.rmSync(outsideDir, { recursive: true, force: true });
	});
});
