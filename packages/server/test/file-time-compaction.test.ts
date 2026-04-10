import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { compactMessages } from "../src/compaction/engine";
import { FileTime } from "../src/file/time";
import type { Message } from "../src/provider/provider";
import { readFileTool } from "../src/tool/read-file";
import { createToolRegistry } from "../src/tool/tool";

describe("FileTime compaction invalidation", () => {
	let tmpDir: string;
	const SESSION = "compaction-test";

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-ft-compact-"));
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	afterEach(() => {
		FileTime.clearSession(SESSION);
	});

	test("compacting a read_file output invalidates its FileTime stamp", () => {
		// Setup: file and stamp
		const file = path.join(tmpDir, "compacted.ts");
		fs.writeFileSync(file, "line\n".repeat(100));
		FileTime.read(SESSION, file);

		// Verify stamp is valid before compaction
		expect(() => FileTime.assert(SESSION, file)).not.toThrow();

		// Move time forward past the grace period so invalidation takes effect
		const origNow = Date.now;
		Date.now = () => origNow() + 61_000;

		// Build a message array where the read_file output will get compacted
		// (high context pressure forces compaction).
		// We need enough messages after the tool output so it appears "old"
		// — the age factor must be high for the strength formula to kick in.
		const filler: Message[] = [];
		for (let i = 0; i < 20; i++) {
			filler.push({ role: "user", content: `Follow-up ${i}` });
			filler.push({ role: "assistant", content: `Response ${i}` });
		}

		const messages: Message[] = [
			{ role: "system", content: "You are a helper." },
			{ role: "user", content: "Read the file" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function" as const,
						function: { name: "read_file", arguments: JSON.stringify({ path: "compacted.ts" }) },
					},
				],
			},
			{
				role: "tool",
				content: "line\n".repeat(100),
				tool_call_id: "call_1",
			},
			...filler,
		];

		const tools = createToolRegistry([readFileTool]);

		const result = compactMessages({
			messages,
			context: { promptTokens: 95_000, contextWindow: 100_000 },
			tools,
			onReadFileCompacted(_toolCallId, callArgs) {
				const filePath = typeof callArgs.path === "string" ? callArgs.path : null;
				if (filePath) {
					const resolved = path.resolve(tmpDir, filePath);
					FileTime.invalidate(SESSION, resolved);
				}
			},
		});

		// Verify compaction happened
		const toolMsg = result.find((m) => m.role === "tool");
		expect(toolMsg?.content).toContain(COMPACTION_MARKER);

		// Verify stamp was invalidated
		Date.now = origNow;
		expect(() => FileTime.assert(SESSION, file)).toThrow("must read");
	});

	test("callback is NOT called when read_file output is not compacted (low pressure)", () => {
		const file = path.join(tmpDir, "not-compacted.ts");
		fs.writeFileSync(file, "short\n");
		FileTime.read(SESSION, file);

		const messages: Message[] = [
			{ role: "system", content: "You are a helper." },
			{ role: "user", content: "Read the file" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_2",
						type: "function" as const,
						function: { name: "read_file", arguments: JSON.stringify({ path: "not-compacted.ts" }) },
					},
				],
			},
			{
				role: "tool",
				content: "short\n",
				tool_call_id: "call_2",
			},
		];

		const tools = createToolRegistry([readFileTool]);
		let callbackCalled = false;

		compactMessages({
			messages,
			context: { promptTokens: 10_000, contextWindow: 100_000 }, // 10% - below 20% threshold
			tools,
			onReadFileCompacted() {
				callbackCalled = true;
			},
		});

		expect(callbackCalled).toBe(false);
		// Stamp should still be valid
		expect(() => FileTime.assert(SESSION, file)).not.toThrow();
	});

	test("callback is NOT called for non-read_file tool compaction", () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a helper." },
			{ role: "user", content: "Run something" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_3",
						type: "function" as const,
						function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
					},
				],
			},
			{
				role: "tool",
				content: "output\n".repeat(100),
				tool_call_id: "call_3",
			},
		];

		// Need bash tool in registry for compaction to know the tool name
		const bashToolStub = {
			definition: {
				type: "function" as const,
				function: { name: "bash", description: "bash", parameters: { type: "object" as const, properties: {} } },
			},
			mergeable: false,
			outputThreshold: 0.4,
			compact(output: string, _callArgs: Record<string, unknown>): string {
				return `# COMPACTED\n${output.slice(0, 50)}`;
			},
			formatCall: () => "bash",
			execute: async () => ({ llmOutput: "", uiOutput: null, mergeable: false }),
		};
		const tools = createToolRegistry([bashToolStub]);
		let callbackCalled = false;

		compactMessages({
			messages,
			context: { promptTokens: 95_000, contextWindow: 100_000 },
			tools,
			onReadFileCompacted() {
				callbackCalled = true;
			},
		});

		expect(callbackCalled).toBe(false);
	});
});
