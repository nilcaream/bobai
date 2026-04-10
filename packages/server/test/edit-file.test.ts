import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTime } from "../src/file/time";
import { editFileTool } from "../src/tool/edit-file";
import type { ToolContext } from "../src/tool/tool";

describe("editFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-edit-file-"));
		ctx = { projectRoot: tmpDir, sessionId: "test-session" };
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	afterEach(() => {
		FileTime.clearSession("test-session");
	});

	function writeAndTrack(relativePath: string, content: string) {
		const resolved = path.join(tmpDir, relativePath);
		fs.writeFileSync(resolved, content);
		FileTime.read("test-session", resolved);
	}

	test("definition has correct name and parameters", () => {
		expect(editFileTool.definition.function.name).toBe("edit_file");
		const params = editFileTool.definition.function.parameters;
		expect(params.required).toContain("path");
		expect(params.required).toContain("old_string");
		expect(params.required).toContain("new_string");
	});

	test("replaces a unique string in a file", async () => {
		writeAndTrack("target.ts", "const x = 1;\nconst y = 2;\nconst z = 3;\n");
		const result = await editFileTool.execute(
			{ path: "target.ts", old_string: "const y = 2;", new_string: "const y = 42;" },
			ctx,
		);
		expect(result.llmOutput).not.toContain("Error");
		const content = fs.readFileSync(path.join(tmpDir, "target.ts"), "utf-8");
		expect(content).toBe("const x = 1;\nconst y = 42;\nconst z = 3;\n");
		expect(result.llmOutput).toContain("target.ts");
	});

	test("returns error when old_string is not found", async () => {
		writeAndTrack("no-match.ts", "hello world\n");
		const result = await editFileTool.execute(
			{ path: "no-match.ts", old_string: "does not exist", new_string: "replacement" },
			ctx,
		);
		expect(result.llmOutput).toContain("not found");
	});

	test("returns error when old_string has multiple matches", async () => {
		writeAndTrack("multi.ts", "foo\nbar\nfoo\n");
		const result = await editFileTool.execute({ path: "multi.ts", old_string: "foo", new_string: "baz" }, ctx);
		expect(result.llmOutput).toContain("multiple");
	});

	test("returns error for nonexistent file", async () => {
		const resolved = path.join(tmpDir, "nope.ts");
		FileTime.read("test-session", resolved);
		const result = await editFileTool.execute({ path: "nope.ts", old_string: "x", new_string: "y" }, ctx);
		expect(result.llmOutput).toContain("not found");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await editFileTool.execute({ path: "../../etc/passwd", old_string: "root", new_string: "hacked" }, ctx);
		expect(result.llmOutput).toContain("outside");
	});

	test("returns error when required args are missing", async () => {
		const r1 = await editFileTool.execute({ old_string: "x", new_string: "y" }, ctx);
		expect(r1.llmOutput).toContain("path");
		const r2 = await editFileTool.execute({ path: "f.ts", new_string: "y" }, ctx);
		expect(r2.llmOutput).toContain("old_string");
		const r3 = await editFileTool.execute({ path: "f.ts", old_string: "x" }, ctx);
		expect(r3.llmOutput).toContain("new_string");
	});

	test("preserves dollar-sign replacement patterns literally in new_string", async () => {
		writeAndTrack("dollar.ts", 'const msg = "hello";\n');
		const result = await editFileTool.execute(
			{ path: "dollar.ts", old_string: 'const msg = "hello";', new_string: "const msg = `cost: $1 or $& or $$`;" },
			ctx,
		);
		expect(result.llmOutput).not.toContain("Error");
		const content = fs.readFileSync(path.join(tmpDir, "dollar.ts"), "utf-8");
		expect(content).toBe("const msg = `cost: $1 or $& or $$`;\n");
	});

	test("returns error when old_string is empty", async () => {
		writeAndTrack("empty-match.ts", "some content\n");
		const result = await editFileTool.execute({ path: "empty-match.ts", old_string: "", new_string: "injected" }, ctx);
		expect(result.llmOutput).toContain("non-empty");
	});

	test("shows context around the edit in output", async () => {
		writeAndTrack("context.ts", "line1\nline2\nline3\nline4\nline5\n");
		const result = await editFileTool.execute({ path: "context.ts", old_string: "line3", new_string: "LINE_THREE" }, ctx);
		expect(result.llmOutput).not.toContain("Error");
		// Output should show surrounding lines for context
		expect(result.llmOutput).toContain("LINE_THREE");
	});

	describe("formatCall", () => {
		test("produces interleaved unified diff for a single changed line", () => {
			const output = editFileTool.formatCall({
				path: "src/app.ts",
				old_string: "const x = 1;\nconst y = 2;\nconst z = 3;",
				new_string: "const x = 1;\nconst y = 42;\nconst z = 3;",
			});
			// Context lines (unchanged) should appear with a space prefix
			expect(output).toContain("  const x = 1;");
			expect(output).toContain("  const z = 3;");
			// Changed lines should be interleaved: removal then addition
			expect(output).toContain("- const y = 2;");
			expect(output).toContain("+ const y = 42;");
			// The removal should come before the addition
			const minusIdx = output.indexOf("- const y = 2;");
			const plusIdx = output.indexOf("+ const y = 42;");
			expect(minusIdx).toBeLessThan(plusIdx);
		});

		test("produces interleaved diff for multiple changed lines", () => {
			const output = editFileTool.formatCall({
				path: "src/app.ts",
				old_string: "aaa\nbbb\nccc\nddd",
				new_string: "aaa\nBBB\nCCC\nddd",
			});
			expect(output).toContain("  aaa");
			expect(output).toContain("- bbb");
			expect(output).toContain("- ccc");
			expect(output).toContain("+ BBB");
			expect(output).toContain("+ CCC");
			expect(output).toContain("  ddd");
		});

		test("handles pure insertion (old_string is subset of new_string)", () => {
			const output = editFileTool.formatCall({
				path: "file.ts",
				old_string: "line1\nline2",
				new_string: "line1\ninserted\nline2",
			});
			expect(output).toContain("  line1");
			expect(output).toContain("+ inserted");
			expect(output).toContain("  line2");
			// No removal lines
			expect(output).not.toContain("- ");
		});

		test("handles pure deletion", () => {
			const output = editFileTool.formatCall({
				path: "file.ts",
				old_string: "line1\nremoved\nline2",
				new_string: "line1\nline2",
			});
			expect(output).toContain("  line1");
			expect(output).toContain("- removed");
			expect(output).toContain("  line2");
			expect(output).not.toContain("+ ");
		});

		test("handles completely different content", () => {
			const output = editFileTool.formatCall({
				path: "file.ts",
				old_string: "old1\nold2",
				new_string: "new1\nnew2",
			});
			expect(output).toContain("- old1");
			expect(output).toContain("- old2");
			expect(output).toContain("+ new1");
			expect(output).toContain("+ new2");
		});

		test("includes file path and diff code fence", () => {
			const output = editFileTool.formatCall({
				path: "src/app.ts",
				old_string: "old",
				new_string: "new",
			});
			expect(output).toContain("▸ Editing src/app.ts");
			expect(output).toContain("```diff");
			expect(output).toContain("```");
		});

		test("handles single-line change", () => {
			const output = editFileTool.formatCall({
				path: "file.ts",
				old_string: "hello",
				new_string: "world",
			});
			expect(output).toContain("- hello");
			expect(output).toContain("+ world");
		});

		test("handles empty new_string (full deletion)", () => {
			const output = editFileTool.formatCall({
				path: "file.ts",
				old_string: "delete me",
				new_string: "",
			});
			expect(output).toContain("- delete me");
		});
	});
});
