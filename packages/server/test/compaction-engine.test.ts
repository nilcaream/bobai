import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import {
	type CompactionDetail,
	compactMessages,
	compactMessagesWithStats,
	MIN_COMPACTION_SAVINGS,
} from "../src/compaction/engine";
import type { Message, ToolMessage } from "../src/provider/provider";
import type { ToolRegistry } from "../src/tool/tool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistry(
	tools: Record<
		string,
		{
			outputThreshold?: number;
			argsThreshold?: number;
			compact?: (
				output: string,
				callArgs: Record<string, unknown>,
				context?: { sessionId: string; toolCallId: string },
			) => string;
			compactArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
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
				outputThreshold: t.outputThreshold,
				argsThreshold: t.argsThreshold,
				compact: t.compact,
				compactArgs: t.compactArgs,
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

/** Context that produces high pressure (~0.8). */
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
 * are not at the newest position (age→0 → compactionFactor→0). The
 * multiplicative formula (contextPressure × age) correctly protects
 * the newest messages from compaction, but test fixtures need trailing
 * context to push tool messages into the compactable zone.
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
		test("returns original messages (same reference) when context pressure is 0", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
				assistantWithToolCall("tc1", "read_file"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: lowPressureContext(),
				tools: createMockRegistry({ read_file: { outputThreshold: 0.3 } }),
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
			// No tool messages → nothing to compact → same reference
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

		test("returns original messages when contextWindow is 0", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(50)),
			];
			const result = compactMessages({
				messages,
				context: { promptTokens: 1000, contextWindow: 0 },
				tools: createMockRegistry({ bash: { outputThreshold: 0.4 } }),
			});
			expect(result).toBe(messages);
		});
	});

	// =======================================================================
	// Output compaction
	// =======================================================================
	describe("output compaction", () => {
		test("compacts tool output when compactionFactor exceeds outputThreshold", () => {
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
				tools: createMockRegistry({
					bash: {
						outputThreshold: 0.2,
						compact: (_output) => `${COMPACTION_MARKER} bash output compacted`,
					},
				}),
			});
			const toolMsg = result[3] as ToolMessage;
			expect(toolMsg.role).toBe("tool");
			expect(toolMsg.content).not.toBe(originalContent);
			expect(toolMsg.content).toContain(COMPACTION_MARKER);
		});

		test("does NOT compact tool output when outputThreshold is undefined", () => {
			const originalContent = multilineOutput(200);
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "nothreshold"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					nothreshold: {
						// no outputThreshold → never compacted
					},
				}),
			});
			const toolMsg = result.find((m) => m.role === "tool") as ToolMessage;
			expect(toolMsg.content).toBe(originalContent);
		});

		test("does NOT compact unknown tools (not in registry)", () => {
			const originalContent = multilineOutput(200);
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "ghost_tool"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry, // ghost_tool not registered
			});
			const toolMsg = result.find((m) => m.role === "tool") as ToolMessage;
			expect(toolMsg.content).toBe(originalContent);
		});

		test("does NOT compact when compactionFactor is below outputThreshold", () => {
			const originalContent = multilineOutput(200);
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "resistant"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			// compactionFactor ≈ 0.78 (pressure 0.8 × age ~0.97)
			// threshold 0.9 → 0.78 < 0.9 → no compaction
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					resistant: {
						outputThreshold: 0.9,
						compact: () => `${COMPACTION_MARKER} should not appear`,
					},
				}),
			});
			const toolMsg = result.find((m) => m.role === "tool") as ToolMessage;
			expect(toolMsg.content).toBe(originalContent);
		});

		test("MIN_COMPACTION_SAVINGS gate prevents compaction when savings are too small", () => {
			const shortContent = "short output";
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "small"),
				toolResult("tc1", shortContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					small: {
						outputThreshold: 0.2,
						// compact returns something nearly as long → savings < 128
						compact: () => "still here",
					},
				}),
			});
			const toolMsg = result.find((m) => m.role === "tool") as ToolMessage;
			expect(toolMsg.content).toBe(shortContent);
		});

		test("preserves tool_call_id in compacted messages", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc-unique-123", "bash"),
				toolResult("tc-unique-123", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					bash: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} bash output compacted`,
					},
				}),
			});
			const toolMsg = result[2] as ToolMessage;
			expect(toolMsg.tool_call_id).toBe("tc-unique-123");
		});

		test("does not mutate the original messages array", () => {
			const originalContent = multilineOutput(200);
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
				tools: createMockRegistry({
					bash: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} bash output compacted`,
					},
				}),
			});
			// Result is a different array
			expect(result).not.toBe(messages);
			// Original array unchanged
			expect(messages).toEqual(messagesCopy);
			// Original tool message content unchanged
			expect((messages[2] as ToolMessage).content).toBe(originalContent);
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
				tools: createMockRegistry({
					bash: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} bash output compacted`,
					},
				}),
			});
			const content = (result[2] as ToolMessage).content;
			expect(content).toContain(COMPACTION_MARKER);
		});

		test("logs warning and skips when tool has outputThreshold but no compact()", () => {
			const originalContent = multilineOutput(200);
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "broken"),
				toolResult("tc1", originalContent),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					broken: {
						outputThreshold: 0.2,
						// has threshold but no compact method — programming error
					},
				}),
			});
			const toolMsg = result.find((m) => m.role === "tool") as ToolMessage;
			// Should skip compaction and pass through original
			expect(toolMsg.content).toBe(originalContent);
		});

		test("fires onReadFileCompacted callback when read_file output is compacted", () => {
			let callbackToolCallId: string | undefined;
			let callbackArgs: Record<string, unknown> | undefined;

			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "read_file", '{"path":"foo.ts"}'),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					read_file: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} read_file compacted`,
					},
				}),
				onReadFileCompacted(toolCallId, callArgs) {
					callbackToolCallId = toolCallId;
					callbackArgs = callArgs;
				},
			});
			expect(callbackToolCallId).toBe("tc1");
			expect(callbackArgs).toEqual({ path: "foo.ts" });
		});
	});

	// =======================================================================
	// Argument compaction
	// =======================================================================
	describe("argument compaction", () => {
		/** Large content string used as a write_file content argument. */
		const largeContent = Array.from({ length: 200 }, (_, i) => `file line ${i + 1}`).join("\n");

		/** Build a write_file assistant message with large content. */
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

		/** Build an edit_file assistant message. */
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

		test("compacts arguments when compactionFactor exceeds argsThreshold", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				editFileAssistant("tc1", "big.ts", largeContent, largeContent),
				toolResult("tc1", "Edited big.ts"),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					edit_file: {
						argsThreshold: 0.3,
						compactArgs(args) {
							return { ...args, old_string: COMPACTION_MARKER, new_string: COMPACTION_MARKER };
						},
					},
				}),
			});

			const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
			const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
			expect(args.path).toBe("big.ts"); // preserved
			expect(args.old_string).toBe(COMPACTION_MARKER);
			expect(args.new_string).toBe(COMPACTION_MARKER);
		});

		test("does NOT compact arguments when argsThreshold is undefined", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				writeFileAssistant("tc1", "big.md", largeContent),
				toolResult("tc1", "Wrote bytes"),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					write_file: {
						// no argsThreshold → never arg-compacted
					},
				}),
			});

			const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
			const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
			expect(args.content).toBe(largeContent);
		});

		test("MIN_COMPACTION_SAVINGS gate works for argument compaction", () => {
			const smallContent = "ab";
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				editFileAssistant("tc1", "tiny.ts", smallContent, smallContent),
				toolResult("tc1", "Edited tiny.ts"),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					edit_file: {
						argsThreshold: 0.3,
						compactArgs(args) {
							return { ...args, old_string: COMPACTION_MARKER, new_string: COMPACTION_MARKER };
						},
					},
				}),
			});

			const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
			const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
			// Content too small → savings < 128 → original preserved
			expect(args.old_string).toBe(smallContent);
			expect(args.new_string).toBe(smallContent);
		});

		test("preserves non-compactable argument fields", () => {
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				writeFileAssistant("tc1", "important/path.md", largeContent),
				toolResult("tc1", "Wrote bytes"),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					write_file: {
						argsThreshold: 0.3,
						compactArgs(args) {
							return { ...args, content: COMPACTION_MARKER };
						},
					},
				}),
			});

			const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
			const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
			expect(args.path).toBe("important/path.md");
		});
	});

	// =======================================================================
	// Age ordering
	// =======================================================================
	describe("age ordering", () => {
		test("older tool messages are more likely to cross threshold than newer ones", () => {
			// Tool with a medium threshold: older messages cross it, newer ones might not.
			// Two tool messages at different positions.
			const output = multilineOutput(200);
			const messages: Message[] = [
				{ role: "user", content: "step 1" },
				assistantWithToolCall("tc1", "tool_a"),
				toolResult("tc1", output), // older, near start
				{ role: "user", content: "step 2" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "step 3" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "step 4" },
				assistantWithToolCall("tc2", "tool_a"),
				toolResult("tc2", output), // newer, near end
			];
			const { details } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					tool_a: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} compacted`,
					},
				}),
			});

			const d1 = details.get("tc1");
			const d2 = details.get("tc2");
			expect(d1).toBeDefined();
			expect(d2).toBeDefined();
			// Older message should have higher compactionFactor
			expect(d1?.compactionFactor).toBeGreaterThan(d2?.compactionFactor ?? 0);
		});
	});

	// =======================================================================
	// Separate thresholds: args compacted before output
	// =======================================================================
	describe("separate thresholds", () => {
		test("edit_file with outputThreshold=0.7 and argsThreshold=0.3: args compacted, output not", () => {
			const largeContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
			// compactionFactor ≈ 0.78 for the first tool message
			// With outputThreshold=0.9, compactionFactor 0.78 < 0.9 → no output compaction
			// With argsThreshold=0.3, compactionFactor 0.78 > 0.3 → args compacted
			const messages: Message[] = [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "tc1",
							type: "function",
							function: {
								name: "edit_file",
								arguments: JSON.stringify({ path: "big.ts", old_string: largeContent, new_string: largeContent }),
							},
						},
					],
				},
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					edit_file: {
						outputThreshold: 0.9, // too high → no output compaction
						argsThreshold: 0.3, // low enough → args compacted
						compact: () => `${COMPACTION_MARKER} edit_file output compacted`,
						compactArgs(args) {
							return { ...args, old_string: COMPACTION_MARKER, new_string: COMPACTION_MARKER };
						},
					},
				}),
			});

			// Tool output should be UNCHANGED (below outputThreshold)
			const toolMsg = result[2] as ToolMessage;
			expect(toolMsg.content).not.toContain(COMPACTION_MARKER);

			// Arguments should be COMPACTED
			const assistantMsg = result[1] as { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> };
			const args = JSON.parse(assistantMsg.tool_calls?.[0]?.function.arguments ?? "{}");
			expect(args.old_string).toBe(COMPACTION_MARKER);
			expect(args.new_string).toBe(COMPACTION_MARKER);
		});
	});

	// =======================================================================
	// Stats and details
	// =======================================================================
	describe("stats and details", () => {
		test("returns correct stats from compactMessagesWithStats", () => {
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
				read_file: {
					outputThreshold: 0.2,
					compact: () => `${COMPACTION_MARKER} read_file compacted`,
				},
				bash: {
					outputThreshold: 0.2,
					compact: () => `${COMPACTION_MARKER} bash compacted`,
				},
			});

			const { stats } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: registry,
			});

			expect(stats.compacted).toBe(2);
			expect(stats.contextPressure).toBeGreaterThan(0);
			expect(stats.totalToolMessages).toBe(2);
			expect(stats.assistantArgsCompacted).toBe(0);
		});

		test("returns per-tool-call-id details", () => {
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
				read_file: {
					outputThreshold: 0.2,
					compact: () => `${COMPACTION_MARKER} read_file compacted`,
				},
				bash: {
					outputThreshold: 0.4,
					compact: () => `${COMPACTION_MARKER} bash compacted`,
				},
			});

			const { details } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: registry,
			});

			expect(details.size).toBe(2);

			const d1 = details.get("tc1") as CompactionDetail;
			expect(d1).toBeDefined();
			expect(d1.age).toBeGreaterThanOrEqual(0);
			expect(d1.age).toBeLessThanOrEqual(1);
			expect(d1.compactionFactor).toBeGreaterThan(0);
			expect(d1.outputThreshold).toBe(0.2);
			expect(d1.wasCompacted).toBe(true);
			expect(d1.savedChars).toBeGreaterThan(0);

			const d2 = details.get("tc2") as CompactionDetail;
			expect(d2).toBeDefined();
			expect(d2.outputThreshold).toBe(0.4);
		});

		test("marks belowMinSavings when savings are too small", () => {
			const shortContent = "short output";
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", shortContent),
				...TRAILING_CONTEXT,
			];

			const registry = createMockRegistry({
				bash: {
					outputThreshold: 0.2,
					compact: () => "compacted",
				},
			});

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
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
			];

			const { details } = compactMessagesWithStats({
				messages,
				context: lowPressureContext(),
				tools: createMockRegistry({ bash: { outputThreshold: 0.2 } }),
			});

			expect(details.size).toBe(0);
		});

		test("includes savedChars matching actual savings", () => {
			const longContent = `${"x".repeat(50)}\n`.repeat(200);
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "read_file", '{"path":"a.ts"}'),
				toolResult("tc1", longContent),
				...TRAILING_CONTEXT,
			];
			const compactedMarker = `${COMPACTION_MARKER} read_file compacted`;
			const registry = createMockRegistry({
				read_file: {
					outputThreshold: 0.2,
					compact: () => compactedMarker,
				},
			});
			const { details, messages: result } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: registry,
			});
			const d1 = details.get("tc1");
			expect(d1?.wasCompacted).toBe(true);
			expect(d1?.savedChars).toBeDefined();
			expect(d1?.savedChars).toBeGreaterThan(0);
			const resultContent = (result.find((m) => m.role === "tool") as ToolMessage).content;
			expect(d1?.savedChars).toBe(longContent.length - resultContent.length);
		});

		test("includes savedArgsChars in details", () => {
			const largeContent = Array.from({ length: 200 }, (_, i) => `file line ${i + 1}`).join("\n");
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "tc1",
							type: "function",
							function: {
								name: "write_file",
								arguments: JSON.stringify({ path: "big.md", content: largeContent }),
							},
						},
					],
				},
				toolResult("tc1", "Wrote bytes"),
				...TRAILING_CONTEXT,
			];
			const registry = createMockRegistry({
				write_file: {
					argsThreshold: 0.3,
					compactArgs(args) {
						return { ...args, content: COMPACTION_MARKER };
					},
				},
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

		test("stats include assistantArgsCompacted count", () => {
			const largeContent = Array.from({ length: 200 }, (_, i) => `file line ${i + 1}`).join("\n");
			const messages: Message[] = [
				{ role: "system", content: "sys" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "tc1",
							type: "function",
							function: {
								name: "write_file",
								arguments: JSON.stringify({ path: "a.md", content: largeContent }),
							},
						},
					],
				},
				toolResult("tc1", "Wrote bytes"),
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "tc2",
							type: "function",
							function: {
								name: "write_file",
								arguments: JSON.stringify({ path: "b.md", content: largeContent }),
							},
						},
					],
				},
				toolResult("tc2", "Wrote bytes"),
				...TRAILING_CONTEXT,
			];
			const registry = createMockRegistry({
				write_file: {
					argsThreshold: 0.3,
					compactArgs(args) {
						return { ...args, content: COMPACTION_MARKER };
					},
				},
			});
			const { stats } = compactMessagesWithStats({
				messages,
				context: highPressureContext(),
				tools: registry,
			});

			expect(stats.assistantArgsCompacted).toBeGreaterThanOrEqual(1);
		});
	});

	// =======================================================================
	// sessionId passed to compact context
	// =======================================================================
	describe("sessionId passed to compact context", () => {
		test("task tool's compact() receives { sessionId, toolCallId }", () => {
			let capturedContext: { sessionId: string; toolCallId: string } | undefined;
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "task", '{"description":"do stuff","prompt":"please"}'),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			compactMessages({
				messages,
				context: highPressureContext(),
				sessionId: "sess-123",
				tools: createMockRegistry({
					task: {
						outputThreshold: 0.2,
						compact: (_output, _callArgs, context) => {
							capturedContext = context;
							return `${COMPACTION_MARKER} task compacted`;
						},
					},
				}),
			});
			expect(capturedContext).toBeDefined();
			expect(capturedContext?.sessionId).toBe("sess-123");
			expect(capturedContext?.toolCallId).toBe("tc1");
		});
	});

	// =======================================================================
	// onReadFileCompacted callback
	// =======================================================================
	describe("onReadFileCompacted callback", () => {
		test("fires when read_file output is compacted", () => {
			let fired = false;
			let firedToolCallId = "";
			let firedArgs: Record<string, unknown> = {};

			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "read_file", '{"path":"src/main.ts","from":1,"to":100}'),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					read_file: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} read_file compacted`,
					},
				}),
				onReadFileCompacted(toolCallId, callArgs) {
					fired = true;
					firedToolCallId = toolCallId;
					firedArgs = callArgs;
				},
			});
			expect(fired).toBe(true);
			expect(firedToolCallId).toBe("tc1");
			expect(firedArgs).toEqual({ path: "src/main.ts", from: 1, to: 100 });
		});

		test("does NOT fire when read_file is not compacted", () => {
			let fired = false;
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "read_file", '{"path":"small.ts"}'),
				toolResult("tc1", "tiny output"),
				...TRAILING_CONTEXT,
			];
			compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					read_file: {
						outputThreshold: 0.2,
						compact: () => "compacted",
					},
				}),
				onReadFileCompacted() {
					fired = true;
				},
			});
			// Savings < MIN_COMPACTION_SAVINGS → not compacted → callback not fired
			expect(fired).toBe(false);
		});
	});

	// =======================================================================
	// Edge cases
	// =======================================================================
	describe("edge cases", () => {
		test("tool with invalid JSON arguments gets empty object in compact()", () => {
			let receivedArgs: Record<string, unknown> | undefined;
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "broken", "NOT VALID JSON{{{"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					broken: {
						outputThreshold: 0.2,
						compact: (_output, args) => {
							receivedArgs = args;
							return `${COMPACTION_MARKER} compacted`;
						},
					},
				}),
			});
			expect(receivedArgs).toEqual({});
		});

		test("empty messages array returns same reference", () => {
			const messages: Message[] = [];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: emptyRegistry,
			});
			expect(result).toBe(messages);
		});

		test("context pressure at exact threshold produces no compaction", () => {
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
			];
			const result = compactMessages({
				messages,
				context: { promptTokens: 5_000, contextWindow: 10_000 }, // exactly 0.5 = threshold
				tools: createMockRegistry({ bash: { outputThreshold: 0.2, compact: () => `${COMPACTION_MARKER} compacted` } }),
			});
			expect(result).toBe(messages); // no compaction
		});

		test("system, user, assistant messages pass through unchanged", () => {
			const sysMsg: Message = { role: "system", content: "important" };
			const userMsg: Message = { role: "user", content: "my input" };
			const assistantMsg: Message = { role: "assistant", content: "my reply" };
			const messages: Message[] = [
				sysMsg,
				userMsg,
				assistantMsg,
				{ role: "user", content: "trigger" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({
					bash: {
						outputThreshold: 0.2,
						compact: () => `${COMPACTION_MARKER} compacted`,
					},
				}),
			});
			expect(result[0]).toBe(sysMsg);
			expect(result[1]).toBe(userMsg);
			expect(result[2]).toBe(assistantMsg);
		});

		test("MIN_COMPACTION_SAVINGS is 128", () => {
			expect(MIN_COMPACTION_SAVINGS).toBe(128);
		});
	});

	// =======================================================================
	// Same-reference safety
	// =======================================================================
	describe("same-reference safety", () => {
		test("returns same reference when nothing changes under pressure", () => {
			// All tools lack outputThreshold → nothing compacted → same reference
			const messages: Message[] = [
				{ role: "user", content: "go" },
				assistantWithToolCall("tc1", "bash"),
				toolResult("tc1", multilineOutput(200)),
				...TRAILING_CONTEXT,
			];
			const result = compactMessages({
				messages,
				context: highPressureContext(),
				tools: createMockRegistry({ bash: {} }), // no outputThreshold
			});
			expect(result).toBe(messages);
		});
	});
});
