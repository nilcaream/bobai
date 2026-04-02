import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type CompactionDumpOptions, formatMessageForDump, writeCompactionDump } from "../src/compaction/dump";
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

function dumpOpts(overrides?: Partial<CompactionDumpOptions>): CompactionDumpOptions {
	return {
		logDir: TEST_DIR,
		before: [{ role: "user", content: "hello" }],
		afterCompaction: [{ role: "user", content: "hello compacted" }],
		code: "pre",
		scope: "abcd1234",
		debug: true,
		...overrides,
	};
}

describe("writeCompactionDump", () => {
	beforeEach(() => {
		fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("filename matches debug-YYYYMMDD-HHMMSSmmm-<scope>-<code>.txt pattern", () => {
		const { preFile, postFile } = writeCompactionDump(dumpOpts());

		expect(preFile).toMatch(/^debug-\d{8}-\d{9}-abcd1234-pre0\.txt$/);
		expect(postFile).toMatch(/^debug-\d{8}-\d{9}-abcd1234-pre1\.txt$/);
	});

	test("all three files share the same prefix", () => {
		const afterCompaction: Message[] = [{ role: "user", content: "compacted" }];
		const afterEviction: Message[] = [{ role: "user", content: "evicted" }];

		const { preFile, postFile, evictionFile } = writeCompactionDump(dumpOpts({ afterCompaction, afterEviction }));

		const prePrefix = preFile.replace(/-pre0\.txt$/, "");
		const postPrefix = postFile.replace(/-pre1\.txt$/, "");
		const evictionPrefix = evictionFile.replace(/-pre2\.txt$/, "");

		expect(prePrefix).toBe(postPrefix);
		expect(postPrefix).toBe(evictionPrefix);
	});

	test("eviction file written when afterEviction differs from afterCompaction", () => {
		const afterCompaction: Message[] = [{ role: "user", content: "compacted" }];
		const afterEviction: Message[] = [{ role: "user", content: "evicted" }];

		const { evictionFile } = writeCompactionDump(dumpOpts({ afterCompaction, afterEviction }));

		expect(evictionFile).toMatch(/^debug-.*-pre2\.txt$/);
		const content = fs.readFileSync(path.join(TEST_DIR, evictionFile), "utf8");
		expect(content).toContain("evicted");
	});

	test("eviction file NOT written when afterEviction === afterCompaction (same ref)", () => {
		const shared: Message[] = [{ role: "user", content: "same" }];

		const { evictionFile } = writeCompactionDump(dumpOpts({ afterCompaction: shared, afterEviction: shared }));

		expect(evictionFile).toBe("");
		const files = fs.readdirSync(TEST_DIR);
		expect(files.length).toBe(2);
	});

	test("eviction file NOT written when afterEviction not provided", () => {
		const { evictionFile } = writeCompactionDump(dumpOpts());

		expect(evictionFile).toBe("");
		const files = fs.readdirSync(TEST_DIR);
		expect(files.length).toBe(2);
	});

	test("nothing written when debug is false", () => {
		const result = writeCompactionDump(dumpOpts({ debug: false }));

		expect(result.preFile).toBe("");
		expect(result.postFile).toBe("");
		expect(result.evictionFile).toBe("");

		const files = fs.readdirSync(TEST_DIR);
		expect(files.length).toBe(0);
	});

	test("defaults to global scope in filename", () => {
		const { preFile } = writeCompactionDump(dumpOpts({ scope: "xyz99999" }));

		expect(preFile).toContain("-xyz99999-");
	});

	test("subagent scope in filename", () => {
		const { preFile, postFile } = writeCompactionDump(dumpOpts({ scope: "abc12345-def67890" }));

		expect(preFile).toContain("-abc12345-def67890-");
		expect(postFile).toContain("-abc12345-def67890-");
	});

	test("pre file contains original messages", () => {
		const before: Message[] = [
			{ role: "user", content: "original question" },
			{ role: "tool", content: "tool output", tool_call_id: "call_x" },
		];
		const afterCompaction: Message[] = [{ role: "user", content: "original question" }];

		const { preFile } = writeCompactionDump(dumpOpts({ before, afterCompaction }));

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
		const afterCompaction: Message[] = [
			{ role: "user", content: "original" },
			{ role: "tool", content: "[compacted]", tool_call_id: "call_y" },
		];

		const { postFile } = writeCompactionDump(dumpOpts({ before, afterCompaction }));

		const content = fs.readFileSync(path.join(TEST_DIR, postFile), "utf8");
		expect(content).toContain("[compacted]");
		expect(content).toContain("original");
	});

	test("returns empty strings on write failure", () => {
		// Create a file at the parent path so mkdirSync fails
		fs.writeFileSync(path.join(TEST_DIR, "nonexistent-file.txt"), "block");
		const badDir = path.join(TEST_DIR, "nonexistent-file.txt", "subdir");

		const result = writeCompactionDump(dumpOpts({ logDir: badDir }));

		expect(result.preFile).toBe("");
		expect(result.postFile).toBe("");
		expect(result.evictionFile).toBe("");
	});
});
