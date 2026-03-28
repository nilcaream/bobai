import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTime } from "../src/file/time";
import { editFileTool } from "../src/tool/edit-file";
import { readFileTool } from "../src/tool/read-file";
import type { ToolContext } from "../src/tool/tool";
import { writeFileTool } from "../src/tool/write-file";

describe("FileTime integration", () => {
	let tmpDir: string;
	let ctx: ToolContext;
	const SESSION = "integration-test";

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-ft-integration-"));
		ctx = { projectRoot: tmpDir, sessionId: SESSION };
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	afterEach(() => {
		FileTime.clearSession(SESSION);
	});

	test("read_file registers stamp so assert passes", async () => {
		const file = path.join(tmpDir, "tracked.ts");
		fs.writeFileSync(file, "content\n");
		await readFileTool.execute({ path: "tracked.ts" }, ctx);
		expect(() => FileTime.assert(SESSION, file)).not.toThrow();
	});

	test("read_file on error does NOT register stamp", async () => {
		await readFileTool.execute({ path: "nonexistent.ts" }, ctx);
		const resolved = path.resolve(tmpDir, "nonexistent.ts");
		expect(() => FileTime.assert(SESSION, resolved)).toThrow("must read");
	});

	test("edit_file fails when file was never read", async () => {
		const file = "unread-edit.ts";
		fs.writeFileSync(path.join(tmpDir, file), "const x = 1;\n");
		const result = await editFileTool.execute({ path: file, old_string: "const x = 1;", new_string: "const x = 2;" }, ctx);
		expect(result.llmOutput).toContain("must read");
		// File should be unchanged
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("const x = 1;\n");
	});

	test("edit_file succeeds after read_file", async () => {
		const file = "read-then-edit.ts";
		fs.writeFileSync(path.join(tmpDir, file), "const x = 1;\n");
		await readFileTool.execute({ path: file }, ctx);
		const result = await editFileTool.execute({ path: file, old_string: "const x = 1;", new_string: "const x = 2;" }, ctx);
		expect(result.llmOutput).not.toContain("Error");
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("const x = 2;\n");
	});

	test("edit_file refreshes stamp, allowing sequential edits", async () => {
		const file = "sequential.ts";
		fs.writeFileSync(path.join(tmpDir, file), "aaa\nbbb\nccc\n");
		await readFileTool.execute({ path: file }, ctx);

		const r1 = await editFileTool.execute({ path: file, old_string: "aaa", new_string: "AAA" }, ctx);
		expect(r1.llmOutput).not.toContain("Error");

		const r2 = await editFileTool.execute({ path: file, old_string: "bbb", new_string: "BBB" }, ctx);
		expect(r2.llmOutput).not.toContain("Error");
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("AAA\nBBB\nccc\n");
	});

	test("edit_file fails when file changed externally after read", async () => {
		const file = "external-change.ts";
		fs.writeFileSync(path.join(tmpDir, file), "original\n");
		await readFileTool.execute({ path: file }, ctx);
		await Bun.sleep(50);
		fs.writeFileSync(path.join(tmpDir, file), "tampered\n");

		const result = await editFileTool.execute({ path: file, old_string: "tampered", new_string: "edited" }, ctx);
		expect(result.llmOutput).toContain("modified since");
		// File should be unchanged
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("tampered\n");
	});

	test("write_file succeeds for new file without prior read", async () => {
		const file = "brand-new.ts";
		const result = await writeFileTool.execute({ path: file, content: "new content" }, ctx);
		expect(result.llmOutput).not.toContain("Error");
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("new content");
	});

	test("write_file fails when overwriting without prior read", async () => {
		const file = "overwrite-no-read.ts";
		fs.writeFileSync(path.join(tmpDir, file), "existing");
		const result = await writeFileTool.execute({ path: file, content: "overwritten" }, ctx);
		expect(result.llmOutput).toContain("must read");
		// File unchanged
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("existing");
	});

	test("write_file succeeds when overwriting after read", async () => {
		const file = "overwrite-after-read.ts";
		fs.writeFileSync(path.join(tmpDir, file), "v1");
		await readFileTool.execute({ path: file }, ctx);
		const result = await writeFileTool.execute({ path: file, content: "v2" }, ctx);
		expect(result.llmOutput).not.toContain("Error");
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("v2");
	});

	test("write_file refreshes stamp after writing", async () => {
		const file = "write-refresh.ts";
		fs.writeFileSync(path.join(tmpDir, file), "v1");
		await readFileTool.execute({ path: file }, ctx);
		await writeFileTool.execute({ path: file, content: "v2" }, ctx);
		// Should be able to write again without re-reading
		const result = await writeFileTool.execute({ path: file, content: "v3" }, ctx);
		expect(result.llmOutput).not.toContain("Error");
		expect(fs.readFileSync(path.join(tmpDir, file), "utf-8")).toBe("v3");
	});
});
