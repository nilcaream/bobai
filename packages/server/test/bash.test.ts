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
		test("single-line command uses fenced bash block without $ prefix", () => {
			const result = bashTool.formatCall({ command: "echo hello" });
			expect(result).toBe("```bash\necho hello\n```");
		});

		test("multi-line command uses fenced bash block", () => {
			const result = bashTool.formatCall({ command: "# list files\nls -la\necho done" });
			expect(result).toBe("```bash\n# list files\nls -la\necho done\n```");
		});

		test("missing command falls back to fenced bash block with ?", () => {
			const result = bashTool.formatCall({});
			expect(result).toBe("```bash\n?\n```");
		});
	});

	describe("uiOutput formatting", () => {
		test("script section is a fenced bash block without $ prefix", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			expect(result.uiOutput).toMatch(/^```bash\necho hello\n```/);
		});

		test("script and output are separated by horizontal rule", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			expect(result.uiOutput).toContain("```\n\n---\n\n```\n");
		});

		test("output section is a plain fenced code block", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			// After the ---, the output is in a plain code block
			const afterRule = result.uiOutput?.split("---\n\n")[1];
			expect(afterRule).toMatch(/^```\nhello\n/);
		});

		test("output does not contain exit code (moved to summary)", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			expect(result.uiOutput).not.toContain("exit code");
		});

		test("multi-line command renders correctly", async () => {
			const result = await bashTool.execute({ command: "# greet\necho hello" }, ctx);
			expect(result.uiOutput).toMatch(/^```bash\n# greet\necho hello\n```/);
		});

		test("no-output command shows (no output) placeholder", async () => {
			const result = await bashTool.execute({ command: "true" }, ctx);
			const afterRule = result.uiOutput?.split("---\n\n")[1];
			expect(afterRule).toMatch(/^```\n\(no output\)\n```$/);
		});
	});

	describe("summary (panel status bar)", () => {
		test("contains timestamp, exit code, and duration", async () => {
			const result = await bashTool.execute({ command: "echo hello" }, ctx);
			expect(result.summary).toBeDefined();
			// Format: YYYY-MM-DD HH:MM:SS | exit code: 0 | 0.XXs
			expect(result.summary).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| exit code: 0 \| \d+\.\d{2}s$/);
		});

		test("reports non-zero exit code", async () => {
			const result = await bashTool.execute({ command: "exit 42" }, ctx);
			expect(result.summary).toMatch(/exit code: 42/);
		});

		test("timeout shows 'timed out' instead of exit code", async () => {
			const result = await bashTool.execute({ command: "sleep 60", timeout: 500 }, ctx);
			expect(result.summary).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| timed out \| \d+\.\d{2}s$/);
		}, 10000);
	});
});
