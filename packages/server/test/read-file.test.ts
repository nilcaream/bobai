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

		// Multi-line file for from/to tests
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		fs.writeFileSync(path.join(tmpDir, "multiline.txt"), lines.join("\n"));
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(readFileTool.definition.function.name).toBe("read_file");
		expect(readFileTool.definition.function.parameters).toHaveProperty("properties");
		expect(readFileTool.definition.function.parameters.properties).toHaveProperty("from");
		expect(readFileTool.definition.function.parameters.properties).toHaveProperty("to");
	});

	test("reads a file with line numbers", async () => {
		const result = await readFileTool.execute({ path: "hello.txt" }, ctx);
		expect(result.output).toContain("1: Hello, world!");
		expect(result.output).toContain("(End of file - total 1 lines)");
		expect(result.isError).toBeUndefined();
	});

	test("reads a nested file", async () => {
		const result = await readFileTool.execute({ path: "sub/nested.txt" }, ctx);
		expect(result.output).toContain("1: nested content");
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

	test("returns error for directory", async () => {
		const result = await readFileTool.execute({ path: "sub" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("directory");
	});

	test("reads specific line range with from/to", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 10, to: 15 }, ctx);
		expect(result.output).toContain("10: line 10");
		expect(result.output).toContain("15: line 15");
		expect(result.output).not.toContain("9: line 9");
		expect(result.output).not.toContain("16: line 16");
		expect(result.output).toContain("Showing lines 10-15 of 50");
	});

	test("reads from a line to end of file", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 48 }, ctx);
		expect(result.output).toContain("48: line 48");
		expect(result.output).toContain("50: line 50");
		expect(result.output).toContain("(End of file - total 50 lines)");
	});

	test("returns error when from is beyond end of file", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 100 }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("beyond end of file");
	});

	test("clamps to when it exceeds file length", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 45, to: 999 }, ctx);
		expect(result.output).toContain("45: line 45");
		expect(result.output).toContain("50: line 50");
		expect(result.output).toContain("(End of file - total 50 lines)");
	});

	test("shows footer with continuation hint when file is truncated", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 1, to: 10 }, ctx);
		expect(result.output).toContain("Showing lines 1-10 of 50");
		expect(result.output).toContain("Use from=11 to continue");
	});

	test("prefixes each line with its line number", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 1, to: 3 }, ctx);
		const lines = result.output.split("\n");
		expect(lines[0]).toBe("1: line 1");
		expect(lines[1]).toBe("2: line 2");
		expect(lines[2]).toBe("3: line 3");
	});

	test("truncates long lines", async () => {
		const longLine = "x".repeat(3000);
		fs.writeFileSync(path.join(tmpDir, "long-line.txt"), longLine);
		const result = await readFileTool.execute({ path: "long-line.txt" }, ctx);
		expect(result.output).toContain("... (truncated)");
		expect(result.output).not.toContain("x".repeat(3000));
	});

	test("enforces byte budget", async () => {
		// Create a file with many lines that exceed 50KB total
		const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${"a".repeat(50)}`);
		fs.writeFileSync(path.join(tmpDir, "large.txt"), lines.join("\n"));
		const result = await readFileTool.execute({ path: "large.txt" }, ctx);
		expect(result.output).toContain("Output capped at 50 KB");
		// Should not contain all 5000 lines
		expect(result.output).not.toContain("line 5000");
	});
});
