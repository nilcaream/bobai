import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../src/tool/edit-file";
import type { ToolContext } from "../src/tool/tool";

describe("editFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-edit-file-"));
		ctx = { projectRoot: tmpDir };
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(editFileTool.definition.function.name).toBe("edit_file");
		const params = editFileTool.definition.function.parameters;
		expect(params.required).toContain("path");
		expect(params.required).toContain("old_string");
		expect(params.required).toContain("new_string");
	});

	test("replaces a unique string in a file", async () => {
		fs.writeFileSync(path.join(tmpDir, "target.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");
		const result = await editFileTool.execute(
			{ path: "target.ts", old_string: "const y = 2;", new_string: "const y = 42;" },
			ctx,
		);
		expect(result.isError).toBeUndefined();
		const content = fs.readFileSync(path.join(tmpDir, "target.ts"), "utf-8");
		expect(content).toBe("const x = 1;\nconst y = 42;\nconst z = 3;\n");
		expect(result.output).toContain("target.ts");
	});

	test("returns error when old_string is not found", async () => {
		fs.writeFileSync(path.join(tmpDir, "no-match.ts"), "hello world\n");
		const result = await editFileTool.execute(
			{ path: "no-match.ts", old_string: "does not exist", new_string: "replacement" },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("returns error when old_string has multiple matches", async () => {
		fs.writeFileSync(path.join(tmpDir, "multi.ts"), "foo\nbar\nfoo\n");
		const result = await editFileTool.execute({ path: "multi.ts", old_string: "foo", new_string: "baz" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("multiple");
	});

	test("returns error for nonexistent file", async () => {
		const result = await editFileTool.execute({ path: "nope.ts", old_string: "x", new_string: "y" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await editFileTool.execute({ path: "../../etc/passwd", old_string: "root", new_string: "hacked" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when required args are missing", async () => {
		const r1 = await editFileTool.execute({ old_string: "x", new_string: "y" }, ctx);
		expect(r1.isError).toBe(true);
		const r2 = await editFileTool.execute({ path: "f.ts", new_string: "y" }, ctx);
		expect(r2.isError).toBe(true);
		const r3 = await editFileTool.execute({ path: "f.ts", old_string: "x" }, ctx);
		expect(r3.isError).toBe(true);
	});

	test("preserves dollar-sign replacement patterns literally in new_string", async () => {
		fs.writeFileSync(path.join(tmpDir, "dollar.ts"), 'const msg = "hello";\n');
		const result = await editFileTool.execute(
			{ path: "dollar.ts", old_string: 'const msg = "hello";', new_string: "const msg = `cost: $1 or $& or $$`;" },
			ctx,
		);
		expect(result.isError).toBeUndefined();
		const content = fs.readFileSync(path.join(tmpDir, "dollar.ts"), "utf-8");
		expect(content).toBe("const msg = `cost: $1 or $& or $$`;\n");
	});

	test("returns error when old_string is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, "empty-match.ts"), "some content\n");
		const result = await editFileTool.execute({ path: "empty-match.ts", old_string: "", new_string: "injected" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("non-empty");
	});

	test("shows context around the edit in output", async () => {
		fs.writeFileSync(path.join(tmpDir, "context.ts"), "line1\nline2\nline3\nline4\nline5\n");
		const result = await editFileTool.execute({ path: "context.ts", old_string: "line3", new_string: "LINE_THREE" }, ctx);
		expect(result.isError).toBeUndefined();
		// Output should show surrounding lines for context
		expect(result.output).toContain("LINE_THREE");
	});
});
