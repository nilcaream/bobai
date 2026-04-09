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
		ctx = { projectRoot: tmpDir, sessionId: "test-session" };
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
		expect(result.llmOutput).toContain("hello.ts");
		expect(result.llmOutput).toContain("world.ts");
	});

	test("scopes search to a subdirectory", async () => {
		const result = await grepSearchTool.execute({ pattern: "import", path: "src" }, ctx);
		expect(result.llmOutput).toContain("app.ts");
		expect(result.llmOutput).not.toContain("hello.ts");
	});

	test("filters by file glob with include", async () => {
		const result = await grepSearchTool.execute({ pattern: "body", include: "*.css" }, ctx);
		expect(result.llmOutput).toContain("app.css");
	});

	test("returns message when no matches found", async () => {
		const result = await grepSearchTool.execute({ pattern: "zzz_nonexistent_zzz" }, ctx);
		expect(result.llmOutput).toContain("No matches");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await grepSearchTool.execute({ pattern: "test", path: "../../" }, ctx);
		expect(result.llmOutput).toContain("outside");
	});

	test("allows searching in accessibleDirectories", async () => {
		const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-grep-extra-"));
		fs.writeFileSync(path.join(extraDir, "data.ts"), 'const target = "found me";\n');
		const ctxWithExtra: ToolContext = { projectRoot: tmpDir, accessibleDirectories: [extraDir], sessionId: "test-session" };
		const result = await grepSearchTool.execute({ pattern: "found me", path: extraDir }, ctxWithExtra);
		expect(result.llmOutput).toContain("data.ts");
		fs.rmSync(extraDir, { recursive: true, force: true });
	});

	test("rejects search path outside both projectRoot and accessibleDirectories", async () => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-grep-outside-"));
		fs.writeFileSync(path.join(outsideDir, "secret.ts"), "secret");
		const ctxWithExtra: ToolContext = { projectRoot: tmpDir, accessibleDirectories: [], sessionId: "test-session" };
		const result = await grepSearchTool.execute({ pattern: "secret", path: outsideDir }, ctxWithExtra);
		expect(result.llmOutput).toContain("outside");
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	test("returns error when pattern is missing", async () => {
		const result = await grepSearchTool.execute({}, ctx);
		expect(result.llmOutput).toContain("pattern");
	});

	test("truncates individual lines longer than 500 characters", async () => {
		const longContent = `const x = "${"A".repeat(600)}";\n`;
		fs.writeFileSync(path.join(tmpDir, "long-line.ts"), longContent);
		const result = await grepSearchTool.execute({ pattern: "AAAA" }, ctx);
		const lines = result.llmOutput.split("\n");
		const longLineMatch = lines.find((l: string) => l.includes("long-line.ts"));
		expect(longLineMatch).toBeDefined();
		expect(longLineMatch?.length).toBeLessThanOrEqual(600); // 500 + file path/line num prefix + truncation notice
		expect(longLineMatch).toContain("... (truncated)");
	});

	test("truncates total output to 20000 characters", async () => {
		// Create many files with long (but under 500-char) lines to exceed 20K total
		const subDir = path.join(tmpDir, "bulk");
		fs.mkdirSync(subDir, { recursive: true });
		for (let i = 0; i < 100; i++) {
			const content = `const match_${i} = "${"X".repeat(300)}";\n`;
			fs.writeFileSync(path.join(subDir, `file${String(i).padStart(3, "0")}.ts`), content);
		}
		const result = await grepSearchTool.execute({ pattern: "match_", path: "bulk" }, ctx);
		expect(result.llmOutput.length).toBeLessThanOrEqual(20_100); // small buffer for the truncation notice itself
		expect(result.llmOutput).toContain("truncated");
		expect(result.llmOutput).toContain("output limit");
	});

	test("uiOutput reflects total result count even when output is truncated", async () => {
		// Reuse the bulk files from above (they persist in tmpDir/bulk)
		const result = await grepSearchTool.execute({ pattern: "match_", path: "bulk" }, ctx);
		expect(result.uiOutput).toContain("100 results");
	});

	test("searches within a single file when path is a file", async () => {
		const result = await grepSearchTool.execute({ pattern: "greeting", path: "hello.ts" }, ctx);
		expect(result.llmOutput).toContain("greeting");
		expect(result.uiOutput).toContain("▸ Searching");
		expect(result.uiOutput).toContain("hello.ts");
		expect(result.uiOutput).toContain("2 results");
		// Should not match content from other files
		expect(result.llmOutput).not.toContain("planet");
	});

	test("single file search returns no results when pattern not in file", async () => {
		const result = await grepSearchTool.execute({ pattern: "planet", path: "hello.ts" }, ctx);
		expect(result.llmOutput).toContain("No matches");
	});

	test("supports ERE alternation with pipe character", async () => {
		const result = await grepSearchTool.execute({ pattern: "greeting|planet" }, ctx);
		expect(result.llmOutput).toContain("hello.ts");
		expect(result.llmOutput).toContain("world.ts");
	});
});
