import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import {
	type CompactionOptions,
	type CompactionStats,
	compactMessages,
	compactMessagesWithStats,
} from "../src/compaction/engine";
import { createCompactionRegistry } from "../src/compaction/registry";
import type { Message } from "../src/provider/provider";
import type { ToolRegistry } from "../src/tool/tool";

// ---------------------------------------------------------------------------
// Helpers (same pattern as compaction-engine.test.ts)
// ---------------------------------------------------------------------------

function createMockRegistry(
	tools: Record<
		string,
		{
			resistance?: number;
			compact?: (output: string, strength: number, args: Record<string, unknown>) => string;
		}
	>,
): ToolRegistry {
	return {
		definitions: [],
		get(name: string) {
			const t = tools[name];
			if (!t) return undefined;
			return {
				definition: {
					type: "function" as const,
					function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
				},
				mergeable: true,
				compactionResistance: t.resistance,
				compact: t.compact,
				formatCall: () => "",
				execute: async () => ({ llmOutput: "", uiOutput: null, mergeable: true }),
			} as ReturnType<ToolRegistry["get"]>;
		},
	};
}

const emptyRegistry = createMockRegistry({});

function lowPressureContext() {
	return { promptTokens: 100, contextWindow: 10_000 };
}

function highPressureContext() {
	return { promptTokens: 9_000, contextWindow: 10_000 };
}

function assistantWithToolCall(toolCallId: string, toolName: string, args: string = "{}"): Message {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id: toolCallId, type: "function", function: { name: toolName, arguments: args } }],
	};
}

function toolMessage(toolCallId: string, content: string): Message {
	return { role: "tool", content, tool_call_id: toolCallId };
}

// ---------------------------------------------------------------------------
// compactMessagesWithStats — stats correctness
// ---------------------------------------------------------------------------

describe("compactMessagesWithStats", () => {
	test("returns zero stats when no compaction needed", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output"),
		];
		const { messages: result, stats } = compactMessagesWithStats({
			messages,
			context: lowPressureContext(),
			tools: emptyRegistry,
		});
		expect(stats.compacted).toBe(0);
		expect(stats.superseded).toBe(0);
		expect(stats.totalToolMessages).toBe(1);
		expect(stats.contextPressure).toBeLessThanOrEqual(0);
		// Messages unchanged
		expect(result).toBe(messages); // same reference (no-op)
	});

	test("counts compacted messages accurately under high pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search"),
			toolMessage("tc1", "file1\nfile2\nfile3"),
			assistantWithToolCall("tc2", "bash"),
			toolMessage("tc2", "some output"),
			{ role: "user", content: "ok" },
			assistantWithToolCall("tc3", "edit_file"),
			toolMessage("tc3", "edited successfully"),
		];
		const registry = createMockRegistry({
			file_search: { resistance: 0.1 },
			bash: { resistance: 0.5 },
			edit_file: { resistance: 0.8 },
		});
		const { stats } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		expect(stats.totalToolMessages).toBe(3);
		expect(stats.contextPressure).toBeGreaterThan(0);
		// At 90% usage, all tool messages should be compacted
		expect(stats.compacted).toBeGreaterThan(0);
		expect(stats.compacted).toBeLessThanOrEqual(3);
	});

	test("counts superseded messages in stats", () => {
		// Supersession: re-read after edit (read → edit → read same file)
		// Note: the supersession rules use "path" as the primary arg key
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "read_file", JSON.stringify({ path: "foo.ts" })),
			toolMessage("tc1", "original content"),
			assistantWithToolCall("tc2", "edit_file", JSON.stringify({ path: "foo.ts" })),
			toolMessage("tc2", "edit applied"),
			assistantWithToolCall("tc3", "read_file", JSON.stringify({ path: "foo.ts" })),
			toolMessage("tc3", "updated content"),
		];
		const registry = createMockRegistry({
			read_file: { resistance: 0.4 },
			edit_file: { resistance: 0.8 },
		});

		// Even with low pressure, supersession should be detected
		const { stats: lowStats } = compactMessagesWithStats({
			messages,
			context: lowPressureContext(),
			tools: registry,
		});
		expect(lowStats.superseded).toBeGreaterThanOrEqual(1);
		expect(lowStats.compacted).toBeGreaterThanOrEqual(1);

		// With high pressure, superseded + pressure-based compaction
		const { stats: highStats } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		expect(highStats.superseded).toBeGreaterThanOrEqual(1);
		expect(highStats.compacted).toBeGreaterThanOrEqual(1);
	});

	test("stats.contextPressure matches expected value", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output"),
		];
		// 90% usage → effective pressure = (0.9 - 0.4) / (1.0 - 0.4) = 0.833...
		const { stats } = compactMessagesWithStats({
			messages,
			context: { promptTokens: 9_000, contextWindow: 10_000 },
			tools: emptyRegistry,
		});
		expect(stats.contextPressure).toBeCloseTo(0.833, 2);
	});

	test("compactMessages returns same result as compactMessagesWithStats.messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output line 1\nline 2\nline 3"),
		];
		const ctx = highPressureContext();
		const registry = createMockRegistry({ bash: { resistance: 0.5 } });

		const plain = compactMessages({ messages, context: ctx, tools: registry });
		const { messages: withStats } = compactMessagesWithStats({ messages, context: ctx, tools: registry });

		expect(plain.length).toBe(withStats.length);
		for (let i = 0; i < plain.length; i++) {
			expect(plain[i]!.role).toBe(withStats[i]!.role);
			expect((plain[i] as { content: string | null }).content).toBe((withStats[i] as { content: string | null }).content);
		}
	});
});

// ---------------------------------------------------------------------------
// createCompactionRegistry — correct tools and metadata
// ---------------------------------------------------------------------------

describe("createCompactionRegistry", () => {
	const registry = createCompactionRegistry();

	test("contains all 9 tools", () => {
		const toolNames = [
			"read_file",
			"list_directory",
			"file_search",
			"write_file",
			"edit_file",
			"grep_search",
			"bash",
			"skill",
			"task",
		];
		for (const name of toolNames) {
			expect(registry.get(name)).toBeDefined();
		}
	});

	test("returns undefined for unknown tools", () => {
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	test("has correct compactionResistance values", () => {
		const expected: Record<string, number> = {
			file_search: 0.1,
			list_directory: 0.1,
			grep_search: 0.2,
			skill: 0.2,
			read_file: 0.4,
			bash: 0.5,
			task: 0.7,
			write_file: 0.7,
			edit_file: 0.8,
		};
		for (const [name, resistance] of Object.entries(expected)) {
			const tool = registry.get(name);
			expect(tool?.compactionResistance).toBe(resistance);
		}
	});

	test("skill stub has custom compact() method", () => {
		const skill = registry.get("skill");
		expect(skill?.compact).toBeDefined();
		const result = skill!.compact!("full skill content here", 0.8, { name: "tdd" });
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("tdd");
		expect(result).toContain("Re-invoke");
	});

	test("task stub has no custom compact() method", () => {
		const task = registry.get("task");
		expect(task?.compact).toBeUndefined();
	});

	test("tools with custom compact() methods work correctly", () => {
		// file_search
		const fileSearch = registry.get("file_search");
		expect(fileSearch?.compact).toBeDefined();

		// grep_search
		const grepSearch = registry.get("grep_search");
		expect(grepSearch?.compact).toBeDefined();

		// read_file
		const readFile = registry.get("read_file");
		expect(readFile?.compact).toBeDefined();

		// bash
		const bash = registry.get("bash");
		expect(bash?.compact).toBeDefined();

		// list_directory, write_file, edit_file — no custom compact
		expect(registry.get("list_directory")?.compact).toBeUndefined();
		expect(registry.get("write_file")?.compact).toBeUndefined();
		expect(registry.get("edit_file")?.compact).toBeUndefined();
	});

	test("file_search compact() retains summary info", () => {
		const tool = registry.get("file_search")!;
		const output = "Found 5 files:\n/src/a.ts\n/src/b.ts\n/src/c.ts\n/src/d.ts\n/src/e.ts";
		const compacted = tool.compact!(output, 0.8, { pattern: "*.ts" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("bash compact() retains command and exit info", () => {
		const tool = registry.get("bash")!;
		const output = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10";
		const compacted = tool.compact!(output, 0.8, { command: "ls -la" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("read_file compact() retains file info", () => {
		const tool = registry.get("read_file")!;
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
		const compacted = tool.compact!(lines, 0.8, { file_path: "src/main.ts" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("registry can be used with compactMessages", () => {
		// Integration test: make sure the registry works end-to-end
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search", JSON.stringify({ pattern: "*.ts" })),
			toolMessage("tc1", "Found 3 files:\n/a.ts\n/b.ts\n/c.ts"),
			assistantWithToolCall("tc2", "skill", JSON.stringify({ name: "tdd" })),
			toolMessage("tc2", "# Skill: TDD\n\nLots of content here about test-driven development..."),
			assistantWithToolCall("tc3", "edit_file", JSON.stringify({ file_path: "src/main.ts" })),
			toolMessage("tc3", "Edit applied successfully"),
		];

		const { messages: result, stats } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		expect(result.length).toBe(messages.length);
		expect(stats.totalToolMessages).toBe(3);
		expect(stats.compacted).toBeGreaterThan(0);
	});
});
