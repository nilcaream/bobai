import { describe, expect, mock, test } from "bun:test";
import { compactToBudget } from "../src/compaction/compact-to-budget";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { EMERGENCY_TARGET, PRE_PROMPT_TARGET } from "../src/compaction/strength";
import type { Message } from "../src/provider/provider";
import type { Tool } from "../src/tool/tool";
import { createToolRegistry } from "../src/tool/tool";

// Helper: create a minimal tool with compaction support
function createCompactableTool(name: string, outputThreshold = 0.3): Tool {
	return {
		definition: {
			type: "function",
			function: { name, description: "", parameters: { type: "object", properties: {} } },
		},
		mergeable: false,
		outputThreshold,
		compact(_output: string) {
			return `${COMPACTION_MARKER} ${name} output was compacted.`;
		},
		formatCall() {
			return "";
		},
		async execute() {
			throw new Error("stub");
		},
	};
}

/**
 * Trailing messages appended after tool results so that tool messages
 * are not at the newest position (distance=0 → compactionFactor=0). With
 * the multiplier-based model, tool messages need to be far enough from
 * the end of the conversation to have meaningful compaction factor.
 * 100 trailing pairs push the tool message's distance well past typical
 * maxDistance values, giving factor≈1.0 at low multipliers.
 */
const TRAILING_CONTEXT: Message[] = Array.from({ length: 100 }, (_, i) =>
	i % 2 === 0 ? { role: "user" as const, content: "continue" } : { role: "assistant" as const, content: "ok" },
);

describe("compactToBudget", () => {
	test("returns unchanged when charBudget is 0 (no ratio available)", () => {
		const messages = [
			{ role: "system" as const, content: "system prompt" },
			{ role: "user" as const, content: "hello" },
		];
		const tools = createToolRegistry([]);
		const result = compactToBudget({
			messages,
			contextWindow: 100000,
			promptTokens: 0,
			promptChars: 0,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
		});
		expect(result.messages).toBe(messages); // same reference
		expect(result.multiplier).toBe(0);
		expect(result.iterations).toBe(0);
		expect(result.charBudget).toBe(0);
	});

	test("returns unchanged when content fits within budget", () => {
		const messages = [
			{ role: "system" as const, content: "system" },
			{ role: "user" as const, content: "hi" },
		];
		const tools = createToolRegistry([]);
		const result = compactToBudget({
			messages,
			contextWindow: 100000,
			promptTokens: 1000,
			promptChars: 3500,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
		});
		expect(result.messages).toBe(messages);
		expect(result.multiplier).toBe(0);
		expect(result.iterations).toBe(0);
		expect(result.charBudget).toBeGreaterThan(0);
	});

	test("compacts when content exceeds budget", () => {
		// Create a conversation that exceeds the budget
		const bigContent = "x".repeat(10000);
		const tool = createCompactableTool("read_file", 0.1);
		const tools = createToolRegistry([tool]);

		const messages: Message[] = [
			{ role: "system" as const, content: "system" },
			{ role: "user" as const, content: "read some files" },
			{
				role: "assistant" as const,
				content: null,
				tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
			},
			{ role: "tool" as const, content: bigContent, tool_call_id: "tc1" },
			{ role: "assistant" as const, content: "Here is the file content." },
			...TRAILING_CONTEXT,
		];

		// charsPerToken = 350/100 = 3.5, budget = 1000 * 0.8 * 3.5 = 2800
		const result = compactToBudget({
			messages,
			contextWindow: 1000,
			promptTokens: 100,
			promptChars: 350,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
		});

		expect(result.charsBefore).toBeGreaterThan(result.charBudget);
		expect(result.charsAfter).toBeLessThan(result.charsBefore);
		expect(result.iterations).toBeGreaterThan(0);
		expect(result.multiplier).toBeGreaterThan(0);
	});

	test("finds highest multiplier where content fits", () => {
		const tool = createCompactableTool("bash", 0.3);
		const tools = createToolRegistry([tool]);

		const messages: Message[] = [
			{ role: "system" as const, content: "s" },
			{ role: "user" as const, content: "u" },
			{
				role: "assistant" as const,
				content: null,
				tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool" as const, content: "x".repeat(5000), tool_call_id: "tc1" },
			{ role: "assistant" as const, content: "done" },
			...TRAILING_CONTEXT,
		];

		// charsPerToken = 350/100 = 3.5, budget = 500 * 0.8 * 3.5 = 1400
		const result = compactToBudget({
			messages,
			contextWindow: 500,
			promptTokens: 100,
			promptChars: 350,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
		});

		expect(result.charBudget).toBe(1400);
		expect(result.iterations).toBeGreaterThanOrEqual(1);
		expect(result.multiplier).toBeGreaterThan(0);
		expect(result.multiplier).toBeLessThanOrEqual(5.0);
	});

	test("EMERGENCY_TARGET produces larger budget than PRE_PROMPT_TARGET", () => {
		const preBudget = 100000 * PRE_PROMPT_TARGET * 3.5; // 280000
		const emgBudget = 100000 * EMERGENCY_TARGET * 3.5; // 315000
		expect(emgBudget).toBeGreaterThan(preBudget);
	});

	test("uses minimum multiplier 0.01 with WARN when nothing fits", () => {
		// Conversation with only user/assistant messages — nothing compactable.
		// The binary search should exhaust without finding a fit, and fall back to 0.01.
		const messages: Message[] = [
			{ role: "system" as const, content: "system" },
			{ role: "user" as const, content: "x".repeat(5000) },
			{ role: "assistant" as const, content: "y".repeat(5000) },
		];
		const tools = createToolRegistry([]);

		const warnMessages: string[] = [];
		const logger = {
			warn(_tag: string, msg: string) {
				warnMessages.push(msg);
			},
			debug: mock(() => {}),
			info: mock(() => {}),
			error: mock(() => {}),
		};

		// charsPerToken = 350/100 = 3.5, budget = 100 * 0.8 * 3.5 = 280
		// Total chars = 6 + 5000 + 5000 = 10006 — way over budget, nothing to compact
		const result = compactToBudget({
			messages,
			contextWindow: 100,
			promptTokens: 100,
			promptChars: 350,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
			logger: logger as never,
		});

		expect(result.charBudget).toBe(280);
		expect(result.multiplier).toBe(0.01);
		// Should have logged a warning about no multiplier fitting
		expect(warnMessages.some((m) => m.includes("no multiplier fits budget"))).toBe(true);
	});

	test("MAX_ITERATIONS safety stops binary search", () => {
		// Verify binary search converges within expected iterations.
		// With range 1..500, ceil(log2(500)) = 9, well under MAX_ITERATIONS=20.
		const tool = createCompactableTool("bash", 0.3);
		const tools = createToolRegistry([tool]);

		const messages: Message[] = [
			{ role: "system" as const, content: "s" },
			{ role: "user" as const, content: "u" },
			{
				role: "assistant" as const,
				content: null,
				tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool" as const, content: "x".repeat(5000), tool_call_id: "tc1" },
			{ role: "assistant" as const, content: "done" },
			...TRAILING_CONTEXT,
		];

		const result = compactToBudget({
			messages,
			contextWindow: 500,
			promptTokens: 100,
			promptChars: 350,
			target: PRE_PROMPT_TARGET,
			type: "pre-prompt",
			tools,
		});

		// ceil(log2(500)) = 9 iterations for full convergence
		expect(result.iterations).toBeLessThanOrEqual(9);
		expect(result.iterations).toBeGreaterThan(0);
	});
});
