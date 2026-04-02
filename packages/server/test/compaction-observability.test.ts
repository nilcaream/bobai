import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { compactMessages, compactMessagesWithStats } from "../src/compaction/engine";
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
			outputThreshold?: number;
			argsThreshold?: number;
			compact?: (output: string, args: Record<string, unknown>) => string;
			compactArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
		}
	>,
): ToolRegistry {
	return {
		definitions: [],
		get(name: string) {
			const t = tools[name];
			if (!t) return undefined;
			// If outputThreshold is set but no compact() provided, create a default one
			const compact =
				t.compact ??
				(t.outputThreshold !== undefined
					? (output: string) => `${COMPACTION_MARKER} ${name} output compacted (was ${output.length} chars)`
					: undefined);
			return {
				definition: {
					type: "function" as const,
					function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
				},
				mergeable: true,
				outputThreshold: t.outputThreshold,
				argsThreshold: t.argsThreshold,
				compact,
				compactArgs: t.compactArgs,
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

/**
 * Trailing messages to push tool results into the compactable age zone.
 * With MAX_AGE_DISTANCE=100, we need 100+ messages after the tool result
 * so that distanceFromEnd >= 100 and age ≈ 1.0.
 */
const TRAILING_CONTEXT: Message[] = Array.from({ length: 100 }, (_, i) =>
	i % 2 === 0 ? ({ role: "user", content: "continue" } as Message) : ({ role: "assistant", content: "ok" } as Message),
);

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
		expect(stats.totalToolMessages).toBe(1);
		expect(stats.contextPressure).toBeLessThanOrEqual(0);
		// Messages unchanged
		expect(result).toBe(messages); // same reference (no-op)
	});

	test("counts compacted messages accurately under high pressure", () => {
		const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search"),
			toolMessage("tc1", longOutput),
			assistantWithToolCall("tc2", "bash"),
			toolMessage("tc2", longOutput),
			{ role: "user", content: "ok" },
			assistantWithToolCall("tc3", "edit_file"),
			toolMessage("tc3", longOutput),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			file_search: { outputThreshold: 0.2 },
			bash: { outputThreshold: 0.4 },
			edit_file: { outputThreshold: 0.7 },
		});
		const { stats } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		expect(stats.totalToolMessages).toBe(3);
		expect(stats.contextPressure).toBeGreaterThan(0);
		// At 90% usage, older tool messages should be compacted
		expect(stats.compacted).toBeGreaterThan(0);
		expect(stats.compacted).toBeLessThanOrEqual(3);
	});

	test("stats.contextPressure matches expected value", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output"),
		];
		// 90% usage → effective pressure = (0.9 - 0.2) / (1.0 - 0.2) = 0.875
		const { stats } = compactMessagesWithStats({
			messages,
			context: { promptTokens: 9_000, contextWindow: 10_000 },
			tools: emptyRegistry,
		});
		expect(stats.contextPressure).toBeCloseTo(0.875, 2);
	});

	test("returns per-message details keyed by tool_call_id", () => {
		const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search", JSON.stringify({ pattern: "*.ts" })),
			toolMessage("tc1", longOutput),
			assistantWithToolCall("tc2", "bash", JSON.stringify({ command: "ls" })),
			toolMessage("tc2", longOutput),
			assistantWithToolCall("tc3", "edit_file", JSON.stringify({ file_path: "src/main.ts" })),
			toolMessage("tc3", longOutput),
		];
		const registry = createMockRegistry({
			file_search: { outputThreshold: 0.2 },
			bash: { outputThreshold: 0.4 },
			edit_file: { outputThreshold: 0.7 },
		});
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		expect(details).toBeInstanceOf(Map);
		expect(details.size).toBe(3);

		for (const id of ["tc1", "tc2", "tc3"]) {
			const detail = details.get(id);
			expect(detail).toBeDefined();
			if (!detail) throw new Error(`Missing detail for ${id}`);
			expect(typeof detail.age).toBe("number");
			expect(typeof detail.compactionFactor).toBe("number");
			expect(typeof detail.wasCompacted).toBe("boolean");
			expect(typeof detail.position).toBe("number");
			expect(detail.position).toBeGreaterThanOrEqual(0);
			expect(detail.position).toBeLessThanOrEqual(1);
			expect(typeof detail.normalizedPosition).toBe("number");
			expect(detail.normalizedPosition).toBeGreaterThanOrEqual(0);
			expect(detail.normalizedPosition).toBeLessThanOrEqual(1);
		}

		// file_search (low threshold) should be compacted more readily than edit_file (high threshold)
		const fsDetail = details.get("tc1");
		const editDetail = details.get("tc3");
		if (!fsDetail || !editDetail) throw new Error("Missing details");
		expect(fsDetail.outputThreshold).toBe(0.2);
		expect(editDetail.outputThreshold).toBe(0.7);
	});

	test("returns empty details map when no compaction needed", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output"),
		];
		const { details } = compactMessagesWithStats({
			messages,
			context: lowPressureContext(),
			tools: emptyRegistry,
		});
		expect(details).toBeInstanceOf(Map);
		expect(details.size).toBe(0);
	});

	test("details can be serialized to plain object for JSON response", () => {
		const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search", JSON.stringify({ pattern: "*.ts" })),
			toolMessage("tc1", longOutput),
			assistantWithToolCall("tc2", "bash", JSON.stringify({ command: "ls" })),
			toolMessage("tc2", longOutput),
		];
		const registry = createMockRegistry({
			file_search: { outputThreshold: 0.2 },
			bash: { outputThreshold: 0.4 },
		});
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		// Simulate what server.ts does: convert Map to plain object
		const detailsObj = Object.fromEntries(details);

		// Should be JSON-serializable
		const json = JSON.stringify(detailsObj);
		const parsed = JSON.parse(json);
		expect(typeof parsed).toBe("object");
		expect(parsed.tc1).toBeDefined();
		expect(parsed.tc2).toBeDefined();
		expect(typeof parsed.tc1.wasCompacted).toBe("boolean");
	});

	test("compactMessages returns same result as compactMessagesWithStats.messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "bash"),
			toolMessage("tc1", "output line 1\nline 2\nline 3"),
		];
		const ctx = highPressureContext();
		const registry = createMockRegistry({ bash: { outputThreshold: 0.4 } });

		const plain = compactMessages({ messages, context: ctx, tools: registry });
		const { messages: withStats } = compactMessagesWithStats({ messages, context: ctx, tools: registry });

		expect(plain.length).toBe(withStats.length);
		for (let i = 0; i < plain.length; i++) {
			const p = plain[i];
			const w = withStats[i];
			if (!p || !w) throw new Error(`Missing message at index ${i}`);
			expect(p.role).toBe(w.role);
			expect((p as { content: string | null }).content).toBe((w as { content: string | null }).content);
		}
	});
});

// ---------------------------------------------------------------------------
// createCompactionRegistry — correct tools and metadata
// ---------------------------------------------------------------------------

describe("createCompactionRegistry", () => {
	const registry = createCompactionRegistry();

	test("contains all 10 tools", () => {
		const toolNames = [
			"read_file",
			"list_directory",
			"file_search",
			"write_file",
			"edit_file",
			"grep_search",
			"bash",
			"sqlite3",
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

	test("has correct outputThreshold values", () => {
		const expected: Record<string, number> = {
			list_directory: 0.2,
			file_search: 0.2,
			grep_search: 0.2,
			read_file: 0.3,
			skill: 0.4,
			bash: 0.4,
			sqlite3: 0.4,
			edit_file: 0.7,
			task: 0.8,
		};
		for (const [name, threshold] of Object.entries(expected)) {
			const tool = registry.get(name);
			expect(tool?.outputThreshold).toBe(threshold);
		}
	});

	test("write_file has no outputThreshold", () => {
		const tool = registry.get("write_file");
		expect(tool?.outputThreshold).toBeUndefined();
	});

	test("has correct argsThreshold values", () => {
		const expected: Record<string, number> = {
			write_file: 0.6,
			edit_file: 0.3,
			task: 0.8,
		};
		for (const [name, threshold] of Object.entries(expected)) {
			const tool = registry.get(name);
			expect(tool?.argsThreshold).toBe(threshold);
		}
	});

	test("tools without argsThreshold have it undefined", () => {
		const noArgs = ["list_directory", "file_search", "grep_search", "read_file", "skill", "bash", "sqlite3"];
		for (const name of noArgs) {
			const tool = registry.get(name);
			expect(tool?.argsThreshold).toBeUndefined();
		}
	});

	test("skill stub has custom compact() method", () => {
		const skill = registry.get("skill");
		expect(skill?.compact).toBeDefined();
		if (!skill?.compact) throw new Error("skill compact() should be defined");
		const result = skill.compact("full skill content here", { name: "tdd" });
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("tdd");
		expect(result).toContain("Re-invoke");
	});

	test("task stub has custom compact() method", () => {
		const task = registry.get("task");
		expect(task?.compact).toBeDefined();
		if (!task?.compact) throw new Error("task compact() should be defined");
		const result = task.compact("task output here", { description: "do something" });
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("do something");
	});

	test("task stub has compactArgs() method", () => {
		const task = registry.get("task");
		expect(task?.compactArgs).toBeDefined();
		if (!task?.compactArgs) throw new Error("task compactArgs() should be defined");
		const result = task.compactArgs({ description: "do something", prompt: "long prompt text" });
		expect(result.description).toBe("do something");
		expect(result.prompt).toBe(COMPACTION_MARKER);
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

		// list_directory — has compact
		const listDir = registry.get("list_directory");
		expect(listDir?.compact).toBeDefined();

		// edit_file — has compact
		const editFile = registry.get("edit_file");
		expect(editFile?.compact).toBeDefined();
	});

	test("file_search compact() retains summary info", () => {
		const tool = registry.get("file_search");
		if (!tool?.compact) throw new Error("file_search compact() should be defined");
		const output = "Found 5 files:\n/src/a.ts\n/src/b.ts\n/src/c.ts\n/src/d.ts\n/src/e.ts";
		const compacted = tool.compact(output, { pattern: "*.ts" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("bash compact() retains command and exit info", () => {
		const tool = registry.get("bash");
		if (!tool?.compact) throw new Error("bash compact() should be defined");
		const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const compacted = tool.compact(output, { command: "ls -la" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("read_file compact() retains file info", () => {
		const tool = registry.get("read_file");
		if (!tool?.compact) throw new Error("read_file compact() should be defined");
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
		const compacted = tool.compact(lines, { file_path: "src/main.ts" });
		expect(compacted).toContain(COMPACTION_MARKER);
	});

	test("registry can be used with compactMessages", () => {
		// Integration test: make sure the registry works end-to-end
		const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "file_search", JSON.stringify({ pattern: "*.ts" })),
			toolMessage("tc1", longOutput),
			assistantWithToolCall("tc2", "skill", JSON.stringify({ name: "tdd" })),
			toolMessage("tc2", longOutput),
			assistantWithToolCall("tc3", "edit_file", JSON.stringify({ file_path: "src/main.ts" })),
			toolMessage("tc3", longOutput),
			...TRAILING_CONTEXT,
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
