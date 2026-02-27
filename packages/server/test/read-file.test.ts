import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../src/tool/read-file";
import type { ToolContext } from "../src/tool/tool";

describe("readFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-read-file-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "hello.txt"), "Hello, world!");
		fs.mkdirSync(path.join(tmpDir, "sub"));
		fs.writeFileSync(path.join(tmpDir, "sub", "nested.txt"), "nested content");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(readFileTool.definition.function.name).toBe("read_file");
		expect(readFileTool.definition.function.parameters).toHaveProperty("properties");
	});

	test("reads a file at project root", async () => {
		const result = await readFileTool.execute({ path: "hello.txt" }, ctx);
		expect(result.output).toBe("Hello, world!");
		expect(result.isError).toBeUndefined();
	});

	test("reads a nested file", async () => {
		const result = await readFileTool.execute({ path: "sub/nested.txt" }, ctx);
		expect(result.output).toBe("nested content");
	});

	test("returns error for nonexistent file", async () => {
		const result = await readFileTool.execute({ path: "nope.txt" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("nope.txt");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await readFileTool.execute({ path: "../../etc/passwd" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when path is missing", async () => {
		const result = await readFileTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
