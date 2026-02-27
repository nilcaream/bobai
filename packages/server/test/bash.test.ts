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
		ctx = { projectRoot: tmpDir };
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
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello world");
	});

	test("runs in projectRoot as working directory", async () => {
		const result = await bashTool.execute({ command: "cat test.txt" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello from test");
	});

	test("returns exit code and stderr on failure", async () => {
		const result = await bashTool.execute({ command: "ls nonexistent_dir_12345" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("exit code");
	});

	test("captures both stdout and stderr", async () => {
		const result = await bashTool.execute({ command: "echo 'out' && echo 'err' >&2" }, ctx);
		// Both streams should be in the output
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	test("respects timeout", async () => {
		const result = await bashTool.execute({ command: "sleep 60", timeout: 500 }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out");
	}, 10000);

	test("returns error when command is missing", async () => {
		const result = await bashTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
