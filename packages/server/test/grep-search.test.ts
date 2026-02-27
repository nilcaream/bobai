import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grepSearchTool } from "../src/tool/grep-search";
import type { ToolContext } from "../src/tool/tool";

describe("grepSearchTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-grep-search-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "hello.ts"), 'const greeting = "hello";\nexport default greeting;\n');
		fs.writeFileSync(path.join(tmpDir, "world.ts"), 'const planet = "world";\nexport default planet;\n');
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), 'import greeting from "../hello";\nconsole.log(greeting);\n');
		fs.writeFileSync(path.join(tmpDir, "src", "app.css"), "body { color: red; }\n");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(grepSearchTool.definition.function.name).toBe("grep_search");
	});

	test("finds pattern across files", async () => {
		const result = await grepSearchTool.execute({ pattern: "export default" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello.ts");
		expect(result.output).toContain("world.ts");
	});

	test("scopes search to a subdirectory", async () => {
		const result = await grepSearchTool.execute({ pattern: "import", path: "src" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("app.ts");
		expect(result.output).not.toContain("hello.ts");
	});

	test("filters by file glob with include", async () => {
		const result = await grepSearchTool.execute({ pattern: "body", include: "*.css" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("app.css");
	});

	test("returns message when no matches found", async () => {
		const result = await grepSearchTool.execute({ pattern: "zzz_nonexistent_zzz" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("No matches");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await grepSearchTool.execute({ pattern: "test", path: "../../" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when pattern is missing", async () => {
		const result = await grepSearchTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
