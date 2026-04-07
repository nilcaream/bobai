import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "../src/tool/bash";
import type { ToolContext } from "../src/tool/tool";

describe("bashTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-bash-"));
		ctx = { projectRoot: tmpDir, sessionId: "test-session" };
		fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello from test");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(bashTool.definition.function.name).toBe("bash");
	});

	test("executes a simple command and returns stdout", async () => {
		const result = await bashTool.execute({ command: "echo 'hello world'" }, ctx);
		expect(result.llmOutput).toContain("hello world");
		expect(result.llmOutput).toContain("exit code: 0");
	});

	test("runs in projectRoot as working directory", async () => {
		const result = await bashTool.execute({ command: "cat test.txt" }, ctx);
		expect(result.llmOutput).toContain("hello from test");
	});

	test("returns exit code and stderr on failure", async () => {
		const result = await bashTool.execute({ command: "ls nonexistent_dir_12345" }, ctx);
		expect(result.llmOutput).toContain("exit code");
	});

	test("captures both stdout and stderr", async () => {
		const result = await bashTool.execute({ command: "echo 'out' && echo 'err' >&2" }, ctx);
		// Both streams should be in the output
		expect(result.llmOutput).toContain("out");
		expect(result.llmOutput).toContain("err");
	});

	test("respects timeout", async () => {
		const result = await bashTool.execute({ command: "sleep 60", timeout: 500 }, ctx);
		expect(result.llmOutput).toContain("timed out");
	}, 10000);

	test("returns error when command is missing", async () => {
		const result = await bashTool.execute({}, ctx);
		expect(result.llmOutput).toContain("command");
	});

	describe("formatCall", () => {
		test("single-line command uses inline code", () => {
			const result = bashTool.formatCall({ command: "echo hello" });
			expect(result).toBe("`$ echo hello`");
		});

		test("multi-line command uses fenced bash block", () => {
			const result = bashTool.formatCall({ command: "# list files\nls -la\necho done" });
			expect(result).toBe("```bash\n# list files\nls -la\necho done\n```");
		});

		test("missing command falls back to inline code", () => {
			const result = bashTool.formatCall({});
			expect(result).toBe("`$ ?`");
		});
	});

	describe("uiOutput formatting", () => {
		test("single-line command uses inline code header", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			expect(result.uiOutput).toMatch(/^`\$ echo hello`/);
			// Output block follows
			expect(result.uiOutput).toContain("```\n");
		});

		test("multi-line command uses fenced bash block header", async () => {
			const result = await bashTool.execute({ command: "# greet\necho hello" }, ctx);
			expect(result.uiOutput).toMatch(/^```bash\n# greet\necho hello\n```/);
			// Output block follows after
			expect(result.uiOutput).toContain("\n\n```\n");
		});
	});
});
