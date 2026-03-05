import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/tool/tool";
import { writeFileTool } from "../src/tool/write-file";

describe("writeFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-write-file-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "existing.txt"), "original content");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(writeFileTool.definition.function.name).toBe("write_file");
		expect(writeFileTool.definition.function.parameters.required).toContain("path");
		expect(writeFileTool.definition.function.parameters.required).toContain("content");
	});

	test("creates a new file", async () => {
		const result = await writeFileTool.execute({ path: "new-file.txt", content: "hello world" }, ctx);
		expect(result.llmOutput).toContain("new-file.txt");
		const written = fs.readFileSync(path.join(tmpDir, "new-file.txt"), "utf-8");
		expect(written).toBe("hello world");
	});

	test("overwrites an existing file", async () => {
		const _result = await writeFileTool.execute({ path: "existing.txt", content: "new content" }, ctx);
		const written = fs.readFileSync(path.join(tmpDir, "existing.txt"), "utf-8");
		expect(written).toBe("new content");
	});

	test("creates parent directories automatically", async () => {
		const _result = await writeFileTool.execute({ path: "deep/nested/dir/file.txt", content: "deep" }, ctx);
		const written = fs.readFileSync(path.join(tmpDir, "deep/nested/dir/file.txt"), "utf-8");
		expect(written).toBe("deep");
	});

	test("returns split llmOutput/uiOutput with mergeable flag", async () => {
		const content = "metadata test content";
		const result = await writeFileTool.execute({ path: "meta-test.txt", content }, ctx);
		expect(result.llmOutput).toContain("meta-test.txt");
		expect(result.uiOutput).toBe(`▸ Writing meta-test.txt (${content.length} bytes)`);
		expect(result.mergeable).toBe(true);
	});

	test("returns error for path traversal attempt", async () => {
		const result = await writeFileTool.execute({ path: "../../etc/evil", content: "bad" }, ctx);
		expect(result.llmOutput).toContain("outside");
	});

	test("returns error when path is missing", async () => {
		const result = await writeFileTool.execute({ content: "hello" }, ctx);
		expect(result.llmOutput).toContain("path");
	});

	test("returns error when content is missing", async () => {
		const result = await writeFileTool.execute({ path: "foo.txt" }, ctx);
		expect(result.llmOutput).toContain("content");
	});
});
