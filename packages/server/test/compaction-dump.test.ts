import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { formatMessageForDump, writeCompactionDump } from "../src/compaction/dump";
import type { Message } from "../src/provider/provider";

const TEST_DIR = path.join(import.meta.dir, ".compaction-dump-test.tmp");

describe("formatMessageForDump", () => {
	test("formats system message", () => {
		const msg: Message = { role: "system", content: "You are helpful." };
		expect(formatMessageForDump(msg)).toBe("role: system\n\nYou are helpful.");
	});

	test("formats user message", () => {
		const msg: Message = { role: "user", content: "Hello" };
		expect(formatMessageForDump(msg)).toBe("role: user\n\nHello");
	});

	test("formats tool message with tool_call_id", () => {
		const msg: Message = { role: "tool", content: "file contents here", tool_call_id: "call_abc" };
		expect(formatMessageForDump(msg)).toBe("role: tool\ntool_call_id: call_abc\n\nfile contents here");
	});

	test("formats assistant message with tool_calls", () => {
		const msg: Message = {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
				},
			],
		};
		const result = formatMessageForDump(msg);
		expect(result).toContain("role: assistant");
		expect(result).toContain('tool_call: call_1 read_file({"path":"foo.ts"})');
	});

	test("formats assistant message with text content", () => {
		const msg: Message = { role: "assistant", content: "Here is the answer." };
		expect(formatMessageForDump(msg)).toBe("role: assistant\n\nHere is the answer.");
	});
});

describe("writeCompactionDump", () => {
	beforeEach(() => {
		fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("writes paired pre/post files with correct naming pattern", () => {
		const before: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
		];
		const after: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello compacted" },
		];

		const { preFile, postFile } = writeCompactionDump(TEST_DIR, before, after, "pre-prompt");

		expect(preFile).toMatch(/^comp-\d{8}_\d{9}-pre-prompt-[a-z0-9]{4}-0\.txt$/);
		expect(postFile).toMatch(/^comp-\d{8}_\d{9}-pre-prompt-[a-z0-9]{4}-1\.txt$/);
	});

	test("pre file contains original messages", () => {
		const before: Message[] = [
			{ role: "user", content: "original question" },
			{ role: "tool", content: "tool output", tool_call_id: "call_x" },
		];
		const after: Message[] = [{ role: "user", content: "original question" }];

		const { preFile } = writeCompactionDump(TEST_DIR, before, after, "test");

		const content = fs.readFileSync(path.join(TEST_DIR, preFile), "utf8");
		expect(content).toContain("original question");
		expect(content).toContain("tool output");
		expect(content).toContain("call_x");
		expect(content).toContain("--- message 0 ---");
		expect(content).toContain("--- message 1 ---");
	});

	test("post file contains compacted messages", () => {
		const before: Message[] = [
			{ role: "user", content: "original" },
			{ role: "tool", content: "long output", tool_call_id: "call_y" },
		];
		const after: Message[] = [
			{ role: "user", content: "original" },
			{ role: "tool", content: "[compacted]", tool_call_id: "call_y" },
		];

		const { postFile } = writeCompactionDump(TEST_DIR, before, after, "test");

		const content = fs.readFileSync(path.join(TEST_DIR, postFile), "utf8");
		expect(content).toContain("[compacted]");
		expect(content).toContain("original");
	});

	test("filenames contain suffix tag", () => {
		const before: Message[] = [{ role: "user", content: "a" }];
		const after: Message[] = [{ role: "user", content: "a" }];

		const { preFile, postFile } = writeCompactionDump(TEST_DIR, before, after, "my-tag");

		expect(preFile).toContain("my-tag");
		expect(postFile).toContain("my-tag");
	});

	test("returns empty strings on write failure", () => {
		const before: Message[] = [{ role: "user", content: "a" }];
		const after: Message[] = [{ role: "user", content: "a" }];

		// Use a path that cannot be created (nested under a file, not a directory)
		const badDir = path.join(TEST_DIR, "nonexistent-file.txt", "subdir");
		// Create a file at the parent path so mkdirSync fails
		fs.writeFileSync(path.join(TEST_DIR, "nonexistent-file.txt"), "block");

		const { preFile, postFile } = writeCompactionDump(badDir, before, after, "fail");

		expect(preFile).toBe("");
		expect(postFile).toBe("");
	});
});
