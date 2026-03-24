import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import {
	type CompactionDetail,
	compactMessages,
	compactMessagesWithStats,
	MIN_COMPACTION_SAVINGS,
} from "../src/compaction/engine";
import { DEFAULT_RESISTANCE } from "../src/compaction/strength";
import type { Message, SystemMessage, ToolMessage } from "../src/provider/provider";
import type { ToolRegistry } from "../src/tool/tool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistry(
	tools: Record<
		string,
		{
			resistance?: number;
			compact?: (output: string, strength: number, args: Record<string, unknown>) => string;
			compactableArgs?: string[];
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
				compactableArgs: t.compactableArgs,
				formatCall: () => "",
				execute: async () => ({ llmOutput: "", uiOutput: null, mergeable: true }),
			} as ReturnType<ToolRegistry["get"]>;
		},
	};
}

const emptyRegistry = createMockRegistry({});

/** Context that produces zero pressure (usage well below threshold). */
function lowPressureContext() {
	return { promptTokens: 100, contextWindow: 10_000 };
}

/** Context that produces high pressure (usage well above threshold). */
function highPressureContext() {
	return { promptTokens: 9_000, contextWindow: 10_000 };
}

/** Build a standard assistant message with one tool call. */
function assistantWithToolCall(toolCallId: string, toolName: string, args: string = "{}"): Message {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id: toolCallId, type: "function", function: { name: toolName, arguments: args } }],
	};
}

/** Build a tool result message. */
function toolResult(toolCallId: string, content: string): Message {
	return { role: "tool", content, tool_call_id: toolCallId };
}

/** Generate a multi-line string with the given number of lines. */
function multilineOutput(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
}

/**
 * Trailing messages appended after tool results so that tool messages
 * are not at the newest position (age=0 → strength=0). The multiplicative
 * formula (cp × age × compactability) correctly protects the newest messages
 * from compaction, but test fixtures need trailing context to push tool
 * messages into the compactable zone.
 */
const TRAILING_CONTEXT: Message[] = [
	{ role: "user", content: "continue" },
	{ role: "assistant", content: "ok" },
	{ role: "user", content: "continue" },
	{ role: "assistant", content: "ok" },
	{ role: "user", content: "continue" },
	{ role: "assistant", content: "ok" },
	{ role: "user", content: "continue" },
	{ role: "assistant", content: "ok" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
	// =======================================================================
	// No-op scenarios
	// =======================================================================
	describe("no-op scenarios", () => {
		test("returns original messages when context pressure is 0 (below threshold)", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
				assistantWithToolCall("tc1", "read_file"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: lowPressureContext(),
				tools: createMockRegistry({ read_file: {} }),
			});
			expect(result).toBe(messages); // same reference — no work done
		});

		test("returns original messages when there are no tool messages", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry,
			});
			// No tool messages → computeMessageStrengths returns empty map → early return
			expect(result).toBe(messages);
		});

		test("returns original messages when only system/user/assistant messages exist", () => {
			const messages: Message[] = [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "follow-up" },
				{ role: "assistant", content: "another answer" },
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry,
			});
			expect(result).toBe(messages);
		});

		test("does not modify system messages", () => {
			const systemMsg: Message = { role: "system", content: "important system instructions" };
			const messages: Message[] = [
				systemMsg,
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result[0]).toBe(systemMsg);
			expect((result[0] as SystemMessage).content).toBe("important system instructions");
		});

		test("does not modify user messages", () => {
			const userMsg: Message = { role: "user", content: "my precious input" };
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				userMsg,
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result[1]).toBe(userMsg);
		});

		test("does not modify assistant messages", () => {
			const assistantMsg = assistantWithToolCall("tc1", "bash");
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "go" },
				assistantMsg,
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result[2]).toBe(assistantMsg);
		});
	});

	// =======================================================================
	// Compaction scenarios
	// =======================================================================
	describe("compaction scenarios", () => {
		test("compacts tool messages when above threshold", () => {
			const originalContent = multilineOutput(200);
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			const toolMsg = result[3] as ToolMessage;
			expect(toolMsg.role).toBe("tool");
			expect(toolMsg.content).not.toBe(originalContent);
			expect(toolMsg.content.length).toBeLessThan(originalContent.length);
		});

		test("uses tool-specific compactionResistance from registry", () => {
			const output = multilineOutput(100);
			// Low resistance → more compaction
			const lowResistanceMessages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "lowres"),
				toolResult("tc1", output),
				...TRAILING_CONTEXT,
			];
			const lowResult = compactMessages({
				messages: lowResistanceMessages,
				context: highPressureContext(),
				tools: createMockRegistry({ lowres: { resistance: 0.0 } }),
			});

			// High resistance → less compaction
			const highResistanceMessages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc2", "highres"),
				toolResult("tc2", output),
				...TRAILING_CONTEXT,
			];
			const highResult = compactMessages({
				messages: highResistanceMessages,
				context: highPressureContext(),
				tools: createMockRegistry({ highres: { resistance: 0.9 } }),
			});

			const lowContent = (lowResult[2] as ToolMessage).content;
			const highContent = (highResult[2] as ToolMessage).content;
			// Lower resistance → more truncation → shorter output
			expect(lowContent.length).toBeLessThan(highContent.length);
		});

		test("falls back to DEFAULT_RESISTANCE (0.3) for unknown tools", () => {
			const output = multilineOutput(100);
			// Tool "mystery" is NOT in the registry — should use DEFAULT_RESISTANCE
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "mystery"),
				toolResult("tc1", output),
				...TRAILING_CONTEXT,
			];
			// Compare with a known tool at DEFAULT_RESISTANCE
			const knownMessages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc2", "known"),
				toolResult("tc2", output),
				...TRAILING_CONTEXT,
			];
			const unknownResult = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry, // "mystery" not found → DEFAULT_RESISTANCE
			});
			const knownResult = compactMessages({
				messages: knownMessages,
				context: highPressureContext(),
				tools: createMockRegistry({ known: { resistance: DEFAULT_RESISTANCE } }),
			});
			const unknownContent = (unknownResult[2] as ToolMessage).content;
			const knownContent = (knownResult[2] as ToolMessage).content;
			// Both use the same resistance so they retain the same number of lines.
			// The only difference is the tool name in the truncation notice.
			const unknownLines = unknownContent.split("\n");
			const knownLines = knownContent.split("\n");
			expect(unknownLines.length).toBe(knownLines.length);
			// Both contain the COMPACTION_MARKER
			expect(unknownContent).toContain(COMPACTION_MARKER);
			expect(knownContent).toContain(COMPACTION_MARKER);
		});

		test("uses tool's custom compact() method when available", () => {
			const customMarker = "CUSTOM_COMPACTED";
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "special"),
				toolResult("tc1", multilineOutput(50)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					special: {
						compact: (_output, strength, _args) => `${customMarker}: strength=${strength.toFixed(2)}`,
					},
				}),
			});
			const content = (result[2] as ToolMessage).content;
			expect(content).toContain(customMarker);
			expect(content).not.toContain(COMPACTION_MARKER);
		});

		test("falls back to defaultCompact when no custom compact method", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "plain"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ plain: {} }), // no compact method
			});
			const content = (result[2] as ToolMessage).content;
			expect(content).toContain(COMPACTION_MARKER);
		});

		test("compacted output contains COMPACTION_MARKER", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			const content = (result[2] as ToolMessage).content;
			expect(content).toContain(COMPACTION_MARKER);
		});

		test("preserves tool_call_id in compacted messages", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc-unique-123", "bash"),
				toolResult("tc-unique-123", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			const toolMsg = result[2] as ToolMessage;
			expect(toolMsg.tool_call_id).toBe("tc-unique-123");
		});

		test("does not mutate the original messages array (creates a new one)", () => {
			const originalContent = multilineOutput(50);
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			const messagesCopy = [...messages];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			// Result is a different array
			expect(result).not.toBe(messages);
			// Original array unchanged
			expect(messages).toEqual(messagesCopy);
			// Original tool message content unchanged
			expect((messages[2] as ToolMessage).content).toBe(originalContent);
		});
	});

	// =======================================================================
	// Conversation flow
	// =======================================================================
	describe("conversation flow", () => {
		test("system + user + assistant with tool_calls + tool result: only tool result gets compacted", () => {
			const sysContent = "You are an assistant.";
			const userContent = "Please read the file.";
			const assistantMsg = assistantWithToolCall("tc1", "read_file", '{"path":"foo.ts"}');
			const toolContent = multilineOutput(200);

			const messages: Message[] = [
				{ role: "system", content: sysContent },
				{ role: "user", content: userContent },
				assistantMsg,
				toolResult("tc1", toolContent),
				...TRAILING_CONTEXT,
			];

			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ read_file: {} }),
			});

			expect(result).toHaveLength(4 + TRAILING_CONTEXT.length);
			// System, user, assistant are untouched (same reference)
			expect(result[0]).toBe(messages[0]);
			expect(result[1]).toBe(messages[1]);
			expect(result[2]).toBe(messages[2]);
			// Tool result is compacted
			const compacted = result[3] as ToolMessage;
			expect(compacted.role).toBe("tool");
			expect(compacted.content).not.toBe(toolContent);
			expect(compacted.content).toContain(COMPACTION_MARKER);
		});

		test("older tool messages get stronger compaction than newer ones", () => {
			// Build a longer conversation: tool messages at index 2 and 5
			const messages: Message[] = [
				{ role: "user", content: "step 1" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(100)), // index 2 — older
				{ role: "user", content: "step 2" },
				assistantWithToolCall("tc2", "bash"),
				toolResult("tc2", multilineOutput(100)), // index 5 — newer
			];

			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});

			const olderContent = (result[2] as ToolMessage).content;
			const newerContent = (result[5] as ToolMessage).content;

			// Older message at lower index → higher age → stronger compaction → shorter
			expect(olderContent.length).toBeLessThanOrEqual(newerContent.length);
		});

		test("multiple tool calls in single assistant message all get correct tool name lookup", () => {
			const messages: Message[] = [
				{ role: "user", content: "do stuff" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
						{ id: "tc2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
					],
				},
				toolResult("tc1", multilineOutput(60)),
				toolResult("tc2", multilineOutput(60)),
				...TRAILING_CONTEXT,
			];

			let readFileCalled = false;
			let bashCalled = false;

			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					read_file: {
						compact: (_output, strength, args) => {
							readFileCalled = true;
							expect(args).toEqual({ path: "a.ts" });
							return `read_file_compacted: ${strength.toFixed(2)}`;
						},
					},
					bash: {
						compact: (_output, strength, args) => {
							bashCalled = true;
							expect(args).toEqual({ command: "ls" });
							return `bash_compacted: ${strength.toFixed(2)}`;
						},
					},
				}),
			});

			expect(readFileCalled).toBe(true);
			expect(bashCalled).toBe(true);
			expect((result[2] as ToolMessage).content).toContain("read_file_compacted");
			expect((result[3] as ToolMessage).content).toContain("bash_compacted");
		});
	});

	// =======================================================================
	// Edge cases
	// =======================================================================
	describe("edge cases", () => {
		test("tool with invalid JSON arguments gets empty object", () => {
			let receivedArgs: Record<string, unknown> | undefined;
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "broken", "NOT VALID JSON{{{"),
				toolResult("tc1", multilineOutput(50)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					broken: {
						compact: (_output, _strength, args) => {
							receivedArgs = args;
							return "compacted";
						},
					},
				}),
			});
			expect(receivedArgs).toEqual({});
			expect((result[2] as ToolMessage).content).toBe("compacted");
		});

		test("empty messages array returns empty array", () => {
			const result = compactMessages({
				messages: [],
				context: highPressureContext(),
				tools: emptyRegistry,
			});
			expect(result).toEqual([]);
		});

		test("single tool message with high pressure gets compacted", () => {
			// Even a minimal conversation with just a tool result (unusual but possible)
			const messages: Message[] = [
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }),
			});
			const toolMsg = result[1] as ToolMessage;
			expect(toolMsg.content).toContain(COMPACTION_MARKER);
		});

		test("tool message referencing tool not in registry uses defaultCompact with 'unknown' name", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "ghost_tool"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			// ghost_tool is NOT in the registry
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry,
			});
			const content = (result[2] as ToolMessage).content;
			// defaultCompact is called with toolName = "unknown" since the tool_call_id
			// won't be found in toolCallMap (assistant message references ghost_tool which
			// registry doesn't know). The toolCallMap still records it with "ghost_tool" as
			// name since buildToolCallMap only checks tools.get for resistance, not existence.
			// Wait — let me re-check: buildToolCallMap calls tools.get(tc.function.name).
			// If undefined, resistance = DEFAULT_RESISTANCE. The entry IS added to the map
			// with toolName = "ghost_tool". So defaultCompact gets "ghost_tool".
			expect(content).toContain(COMPACTION_MARKER);
			expect(content).toContain("ghost_tool");
		});

		test("context pressure at exact threshold produces no compaction", () => {
			// DEFAULT_THRESHOLD is 0.6, so at exactly 60% usage → pressure = 0
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: { promptTokens: 6_000, contextWindow: 10_000 }, // exactly 0.6
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result).toBe(messages); // no compaction
		});

		test("context pressure just above threshold produces compaction", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: { promptTokens: 6_100, contextWindow: 10_000 }, // 0.61 > 0.6 threshold
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result).not.toBe(messages); // compaction occurred
		});

		test("custom compact receives correct strength and call args", () => {
			let capturedStrength: number | undefined;
			let capturedArgs: Record<string, unknown> | undefined;
			let capturedOutput: string | undefined;

			const toolOutput = multilineOutput(50);
			const callArgs = '{"file":"test.ts","line":42}';

			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "inspector", callArgs),
				toolResult("tc1", toolOutput),
				...TRAILING_CONTEXT,
			];

			compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					inspector: {
						compact: (output, strength, args) => {
							capturedOutput = output;
							capturedStrength = strength;
							capturedArgs = args;
							return "inspected";
						},
					},
				}),
			});

			expect(capturedOutput).toBe(toolOutput);
			expect(capturedStrength).toBeGreaterThan(0);
			expect(capturedStrength).toBeLessThanOrEqual(1);
			expect(capturedArgs).toEqual({ file: "test.ts", line: 42 });
		});

		test("contextWindow of 0 produces no compaction", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: { promptTokens: 1000, contextWindow: 0 },
				tools: createMockRegistry({ bash: {} }),
			});
			expect(result).toBe(messages);
		});
	});

	describe("same-reference safety", () => {
		test("reassigning from compactMessages when pressure is zero preserves messages", () => {
			// Regression test: when compactMessages returns the same array reference
			// (pressure = 0), the old mutate-then-refill pattern
			//   messages.length = 0; messages.push(...compacted)
			// would empty the array because compacted IS messages.
			// The fix is to reassign: messages = compactMessages(...)
			const original: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", "some output"),
			];

			// Low pressure → engine returns same reference
			const result = compactMessages({
				messages: original,
				context: lowPressureContext(),
				tools: createMockRegistry({ bash: { resistance: 0.5 } }),
			});

			// The result IS the same reference (engine optimization)
			expect(result).toBe(original);

			// Simulate the fixed handler pattern: reassign, don't mutate
			let messages = [...original];
			messages = compactMessages({
				messages,
				context: lowPressureContext(),
				tools: createMockRegistry({ bash: { resistance: 0.5 } }),
			});

			// All messages preserved
			expect(messages).toHaveLength(4);
			expect(messages[0]).toEqual({ role: "system", content: "sys" });
			expect(messages[1]).toEqual({ role: "user", content: "hello" });
		});

		test("the old mutate-then-refill pattern would empty the array (documents the bug)", () => {
			// This test documents what the bug did, proving the fix was necessary
			const original: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
			];

			const result = compactMessages({
				messages: original,
				context: lowPressureContext(),
				tools: emptyRegistry,
			});

			// Same reference when pressure is zero
			expect(result).toBe(original);

			// Simulate the OLD buggy pattern:
			const buggyMessages = [...original];
			const compacted = compactMessages({
				messages: buggyMessages,
				context: lowPressureContext(),
				tools: emptyRegistry,
			});
			// compacted IS buggyMessages (same ref)
			expect(compacted).toBe(buggyMessages);
			// The old code did: buggyMessages.length = 0; buggyMessages.push(...compacted)
			// Which would empty both since they're the same array
			buggyMessages.length = 0;
			expect(compacted).toHaveLength(0); // compacted is now also empty!
			buggyMessages.push(...compacted);
			expect(buggyMessages).toHaveLength(0); // bug: all messages lost
		});
	});

	// =======================================================================
	// Minimum compaction savings threshold
	// =======================================================================
	describe("minimum compaction savings threshold", () => {
		test("MIN_COMPACTION_SAVINGS is 128", () => {
			expect(MIN_COMPACTION_SAVINGS).toBe(128);
		});

		test("skips compaction when savings are below MIN_COMPACTION_SAVINGS", () => {
			const shortContent = "src\ntarget\nnode_modules";
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				assistantWithToolCall("tc1", "list_directory", '{"path":"/project"}'),
				toolResult("tc1", shortContent),
			];
			// High pressure — would normally compact
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ list_directory: { resistance: 0.1 } }),
			});
			const toolMsg = result.find((m) => m.role === "tool") as { content: string };
			expect(toolMsg.content).toBe(shortContent);
		});

		test("applies compaction when savings exceed MIN_COMPACTION_SAVINGS", () => {
			const longContent = "line content here\n".repeat(100); // ~1800 chars
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				assistantWithToolCall("tc1", "list_directory", '{"path":"/project"}'),
				toolResult("tc1", longContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ list_directory: { resistance: 0.1 } }),
			});
			const toolMsg = result.find((m) => m.role === "tool") as { content: string };
			expect(toolMsg.content).not.toBe(longContent);
		});

		test("compactedCount excludes messages skipped due to minimum savings", () => {
			const shortContent = "abc";
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				assistantWithToolCall("tc1", "list_directory", "{}"),
				toolResult("tc1", shortContent),
			];
			const { stats } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ list_directory: { resistance: 0.1 } }),
			});
			expect(stats.compacted).toBe(0);
		});

		test("preserves original message reference when savings are below threshold", () => {
			const shortContent = "short output";
			const originalToolMsg = toolResult("tc1", shortContent);
			const messages: Message[] = [{ role: "system", content: "sys" }, assistantWithToolCall("tc1", "bash"), originalToolMsg];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: { resistance: 0.1 } }),
			});
			const toolMsg = result.find((m) => m.role === "tool");
			// Should be the exact same object reference since we kept the original
			expect(toolMsg).toBe(originalToolMsg);
		});
	});
});

// ---------------------------------------------------------------------------
// CompactionDetail tests
// ---------------------------------------------------------------------------

describe("CompactionDetail", () => {
	test("returns detail for each tool message", () => {
		// Use large content (50 chars/line × 200 lines = 10KB) to ensure
		// compaction savings comfortably exceed MIN_COMPACTION_SAVINGS (128 chars).
		const longContent = `${"x".repeat(50)}\n`.repeat(200);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "read_file", '{"path":"a.ts"}'),
			toolResult("tc1", longContent),
			{ role: "user", content: "more" },
			assistantWithToolCall("tc2", "bash", '{"command":"ls"}'),
			toolResult("tc2", longContent),
			...TRAILING_CONTEXT,
		];

		const registry = createMockRegistry({
			read_file: { resistance: 0.2 },
			bash: { resistance: 0.5 },
		});

		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		expect(details.size).toBe(2);

		const d1 = details.get("tc1") as CompactionDetail;
		expect(d1).toBeDefined();
		expect(d1.resistance).toBe(0.2);
		expect(d1.age).toBeGreaterThanOrEqual(0);
		expect(d1.age).toBeLessThanOrEqual(1);
		expect(d1.strength).toBeGreaterThan(0);
		expect(d1.wasCompacted).toBe(true);

		const d2 = details.get("tc2") as CompactionDetail;
		expect(d2).toBeDefined();
		expect(d2.resistance).toBe(0.5);
		expect(d2.age).toBeGreaterThanOrEqual(0);
		expect(d2.age).toBeLessThanOrEqual(1);
		expect(d2.strength).toBeGreaterThan(0);
	});

	test("marks superseded messages with reason", () => {
		const longContent = "x\n".repeat(200);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "read_file", '{"path":"foo.ts"}'),
			toolResult("tc1", longContent),
			{ role: "user", content: "again" },
			assistantWithToolCall("tc2", "read_file", '{"path":"foo.ts"}'),
			toolResult("tc2", longContent),
		];

		const registry = createMockRegistry({ read_file: { resistance: 0.2 } });

		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		const d1 = details.get("tc1") as CompactionDetail;
		expect(d1).toBeDefined();
		expect(d1.supersededReason).toBeDefined();
		expect(typeof d1.supersededReason).toBe("string");
		expect(d1.supersededReason?.length).toBeGreaterThan(0);

		// The second (latest) read should NOT be superseded
		const d2 = details.get("tc2") as CompactionDetail;
		expect(d2).toBeDefined();
		expect(d2.supersededReason).toBeUndefined();
	});

	test("marks belowMinSavings when savings are too small", () => {
		const shortContent = "short output";
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "bash"),
			toolResult("tc1", shortContent),
			...TRAILING_CONTEXT,
		];

		const registry = createMockRegistry({ bash: { resistance: 0.1 } });

		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		const d1 = details.get("tc1") as CompactionDetail;
		expect(d1).toBeDefined();
		expect(d1.wasCompacted).toBe(false);
		expect(d1.belowMinSavings).toBe(true);
	});

	test("returns empty details when pressure is zero", () => {
		const longContent = "x\n".repeat(200);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "bash"),
			toolResult("tc1", longContent),
		];

		const registry = createMockRegistry({ bash: {} });

		const { details } = compactMessagesWithStats({
			messages,
			context: lowPressureContext(),
			tools: registry,
		});

		expect(details.size).toBe(0);
	});

	test("includes savedChars when compaction is applied", () => {
		const longContent = `${"x".repeat(50)}\n`.repeat(200);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "read_file", '{"path":"a.ts"}'),
			toolResult("tc1", longContent),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({ read_file: { resistance: 0.2 } });
		const { details, messages: result } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		const d1 = details.get("tc1");
		expect(d1?.wasCompacted).toBe(true);
		expect(d1?.savedChars).toBeDefined();
		expect(d1?.savedChars).toBeGreaterThan(0);
		// Verify savedChars matches actual savings
		const resultContent = (result.find((m) => m.role === "tool") as { content: string }).content;
		expect(d1?.savedChars).toBe(longContent.length - resultContent.length);
	});

	test("savedChars is undefined when compaction not applied", () => {
		const shortContent = "short";
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "bash"),
			toolResult("tc1", shortContent),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({ bash: { resistance: 0.1 } });
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		const d1 = details.get("tc1");
		expect(d1?.wasCompacted).toBe(false);
		expect(d1?.savedChars).toBeUndefined();
	});

	test("includes supersededBy when message is superseded", () => {
		const longContent = "x\n".repeat(200);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "read_file", '{"path":"foo.ts"}'),
			toolResult("tc1", longContent),
			{ role: "user", content: "again" },
			assistantWithToolCall("tc2", "read_file", '{"path":"foo.ts"}'),
			toolResult("tc2", longContent),
		];
		const registry = createMockRegistry({ read_file: { resistance: 0.2 } });
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		const d1 = details.get("tc1");
		expect(d1?.supersededBy).toBe("tc2");
		const d2 = details.get("tc2");
		expect(d2?.supersededBy).toBeUndefined();
	});

	test("supersededBy is undefined for failed bash (self-supersession)", () => {
		const longContent = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\nexit code: 1`;
		const messages: Message[] = [
			{ role: "user", content: "go" },
			assistantWithToolCall("tc1", "bash", '{"command":"make"}'),
			toolResult("tc1", longContent),
		];
		const registry = createMockRegistry({ bash: { resistance: 0.5 } });
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});
		const d1 = details.get("tc1");
		expect(d1?.supersededBy).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Assistant tool_call argument compaction
// ---------------------------------------------------------------------------

describe("assistant tool_call argument compaction", () => {
	/** Large content string that will be used as a write_file content argument. */
	const largeContent = Array.from({ length: 200 }, (_, i) => `file line ${i + 1}`).join("\n");

	/** Build a write_file assistant message with large content in the arguments. */
	function writeFileAssistant(toolCallId: string, filePath: string, content: string): Message {
		return {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: toolCallId,
					type: "function",
					function: {
						name: "write_file",
						arguments: JSON.stringify({ path: filePath, content }),
					},
				},
			],
		};
	}

	/** Build an edit_file assistant message with large old_string/new_string in arguments. */
	function editFileAssistant(toolCallId: string, filePath: string, oldStr: string, newStr: string): Message {
		return {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: toolCallId,
					type: "function",
					function: {
						name: "edit_file",
						arguments: JSON.stringify({ path: filePath, old_string: oldStr, new_string: newStr }),
					},
				},
			],
		};
	}

	test("compacts write_file content argument under pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "big.md", largeContent),
			toolResult("tc1", "Wrote 3000 bytes to big.md"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		// The assistant message should have been modified
		const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
		expect(args.path).toBe("big.md"); // path preserved
		expect(args.content).toContain("# COMPACTED"); // content compacted
		expect(args.content.length).toBeLessThan(largeContent.length);
	});

	test("compacts edit_file old_string and new_string arguments under pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			editFileAssistant("tc1", "big.ts", largeContent, largeContent),
			toolResult("tc1", "Edited big.ts"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			edit_file: { resistance: 0.8, compactableArgs: ["old_string", "new_string"] },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
		expect(args.path).toBe("big.ts");
		expect(args.old_string).toContain("# COMPACTED");
		expect(args.new_string).toContain("# COMPACTED");
	});

	test("does not compact arguments when no pressure", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "big.md", largeContent),
			toolResult("tc1", "Wrote bytes"),
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const result = compactMessages({
			messages,
			context: lowPressureContext(),
			tools: registry,
		});

		// Should be the same reference (no changes)
		expect(result).toBe(messages);
	});

	test("does not compact arguments for tools without compactableArgs", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			assistantWithToolCall("tc1", "bash", JSON.stringify({ command: "echo hello" })),
			toolResult("tc1", multilineOutput(200)),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			bash: { resistance: 0.5 },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		// Assistant message should be unchanged (bash has no compactableArgs)
		const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		expect(assistantMsg.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ command: "echo hello" }));
	});

	test("preserves non-compactable argument fields", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "important/path.md", largeContent),
			toolResult("tc1", "Wrote bytes"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
		expect(args.path).toBe("important/path.md");
	});

	test("stats include assistantArgsCompacted count", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "a.md", largeContent),
			toolResult("tc1", "Wrote bytes"),
			writeFileAssistant("tc2", "b.md", largeContent),
			toolResult("tc2", "Wrote bytes"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const { stats } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		expect(stats.assistantArgsCompacted).toBeGreaterThanOrEqual(1);
	});

	test("details include savedArgsChars", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "big.md", largeContent),
			toolResult("tc1", "Wrote bytes"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const { details } = compactMessagesWithStats({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		const d = details.get("tc1");
		expect(d).toBeDefined();
		expect(d?.savedArgsChars).toBeDefined();
		expect(d?.savedArgsChars ?? 0).toBeGreaterThan(0);
	});

	test("superseded write_file gets arguments aggressively compacted", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			// First write
			writeFileAssistant("tc1", "foo.md", largeContent),
			toolResult("tc1", "Wrote bytes"),
			// Second write to same file (supersedes first)
			writeFileAssistant("tc2", "foo.md", largeContent),
			toolResult("tc2", "Wrote bytes"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		// The first (superseded) assistant's content arg should be heavily compacted
		const firstAssistant = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args = JSON.parse(firstAssistant.tool_calls?.[0]?.function.arguments ?? "{}");
		expect(args.content).toContain("# COMPACTED");

		// The second (superseding) one may also be compacted but less aggressively
		const secondAssistant = result[3] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args2 = JSON.parse(secondAssistant.tool_calls?.[0]?.function.arguments ?? "{}");
		// Second is recent so may or may not be compacted depending on age
		expect(args2.path).toBe("foo.md");
	});

	test("skips argument compaction when savings below MIN_COMPACTION_SAVINGS", () => {
		// Small content that won't save enough when compacted
		const smallContent = "line1\nline2\nline3\nline4";
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			writeFileAssistant("tc1", "tiny.md", smallContent),
			toolResult("tc1", "Wrote bytes"),
			...TRAILING_CONTEXT,
		];
		const registry = createMockRegistry({
			write_file: { resistance: 0.7, compactableArgs: ["content"] },
		});
		const result = compactMessages({
			messages,
			context: highPressureContext(),
			tools: registry,
		});

		// Arguments should be unchanged since savings < 128 chars
		const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
		const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
		expect(args.content).toBe(smallContent);
	});
});
