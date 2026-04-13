import type { AssistantMessage, Message } from "../provider/provider";
import type { Tool, ToolRegistry } from "../tool/tool";
import { computeCompactionFactor, DEFAULT_MAX_DISTANCE } from "./strength";

/** Minimum character savings required for compaction to be applied.
 * If compacting saves fewer than this many characters, the original
 * content is kept. Prevents cases where the COMPACTED marker is
 * nearly as long as the original content. */
export const MIN_COMPACTION_SAVINGS = 128;

export interface CompactionOptions {
	/** Full message array (as loaded from DB). */
	messages: Message[];
	/** Multiplier for the compaction factor formula. Higher = less aggressive compaction. */
	multiplier: number;
	/** Tool registry to look up compaction thresholds and compact methods. */
	tools: ToolRegistry;
	/** Session identifier passed to tool compact() context (e.g. for task tool). */
	sessionId?: string;
	/** Called when a read_file tool output is compacted, so callers can invalidate FileTime stamps. */
	onReadFileCompacted?(toolCallId: string): void;
}

/** Statistics about what the compaction engine did on a given run. */
export interface CompactionStats {
	/** Number of tool messages that were compacted. */
	compacted: number;
	/** Number of assistant tool_call argument sets that were compacted. */
	assistantArgsCompacted: number;
	/** Number of messages evicted. */
	evicted: number;
	/** Total tool messages in the input. */
	totalToolMessages: number;
}

/** Per-message compaction decision detail, keyed by tool_call_id. */
export interface CompactionDetail {
	/** Distance from end of conversation in messages. */
	distance: number;
	/** Compaction factor = distance / (multiplier × maxDistance), clamped to [0,1]. */
	compactionFactor: number;
	/** The maxDistance used for this message's factor computation. */
	maxDistance: number;
	/** Tool's outputThreshold (undefined if tool has none). */
	outputThreshold?: number;
	/** Tool's argsThreshold (undefined if tool has none). */
	argsThreshold?: number;
	/** Whether this message's content was actually modified by compaction. */
	wasCompacted: boolean;
	/** Whether this message was evicted (factor >= 1.0). */
	wasEvicted: boolean;
	/** If compaction was skipped because savings were below MIN_COMPACTION_SAVINGS. */
	belowMinSavings?: boolean;
	/** Characters saved by output compaction. */
	savedChars: number;
	/** Characters saved by compacting assistant tool_call arguments for this tool_call_id. */
	savedArgsChars: number;
}

/** Combined result from the stats variant. */
export interface CompactionResult {
	/** Post-compaction + post-eviction messages. */
	messages: Message[];
	/** Post-compaction, pre-eviction messages (for dump files). */
	preEviction: Message[];
	/** Compaction statistics. */
	stats: CompactionStats;
	/** Per-tool-call-id decision details. */
	details: Map<string, CompactionDetail>;
}

/**
 * Build a lookup from tool_call_id → { toolName, tool, callArgs, assistantIndex }
 * by walking assistant messages that contain tool_calls.
 */
function buildToolCallMap(
	messages: Message[],
	tools: ToolRegistry,
): Map<string, { toolName: string; tool: Tool | undefined; callArgs: Record<string, unknown>; assistantIndex: number }> {
	const map = new Map<
		string,
		{ toolName: string; tool: Tool | undefined; callArgs: Record<string, unknown>; assistantIndex: number }
	>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls) continue;

		for (const tc of assistantMsg.tool_calls) {
			let callArgs: Record<string, unknown>;
			try {
				callArgs = JSON.parse(tc.function.arguments);
			} catch {
				callArgs = {};
			}
			map.set(tc.id, {
				toolName: tc.function.name,
				tool: tools.get(tc.function.name),
				callArgs,
				assistantIndex: i,
			});
		}
	}

	return map;
}

/**
 * Run the compaction engine over a message array.
 *
 * Returns a new message array with tool outputs compacted and old messages
 * evicted according to each tool's maxDistance and the given multiplier.
 *
 * System messages are never compacted or evicted.
 *
 * This is a pure function — the input array is not mutated.
 */
export function compactMessages(options: CompactionOptions): Message[] {
	return compactMessagesWithStats(options).messages;
}

/**
 * Same as compactMessages but also returns pre-eviction messages, statistics,
 * and per-tool-call details.
 */
export function compactMessagesWithStats(options: CompactionOptions): CompactionResult {
	return compactMessagesInternal(options);
}

function compactMessagesInternal(options: CompactionOptions): CompactionResult {
	const { messages, multiplier, tools, sessionId } = options;
	const totalMessages = messages.length;

	// Count total tool messages for stats
	const totalToolMessages = messages.filter((m) => m.role === "tool").length;

	// ===== Phase 1: Build lookup maps =====
	const toolCallMap = buildToolCallMap(messages, tools);

	// ===== Phase 2: Compute factors and compact =====
	// We need tool message factors first, because assistant arg compaction
	// uses the paired tool message's factor.
	const toolFactors = new Map<string, { factor: number; maxDist: number }>();
	for (let i = 0; i < totalMessages; i++) {
		const msg = messages[i];
		if (msg.role !== "tool") continue;
		const toolMsg = msg as { role: "tool"; tool_call_id: string };
		const info = toolCallMap.get(toolMsg.tool_call_id);
		const tool = info?.tool;
		const maxDist = tool?.maxDistance ?? DEFAULT_MAX_DISTANCE;
		const distance = totalMessages - 1 - i;
		const factor = computeCompactionFactor(distance, multiplier, maxDist);
		toolFactors.set(toolMsg.tool_call_id, { factor, maxDist });
	}

	const compactedMessages: Message[] = [];
	const details = new Map<string, CompactionDetail>();
	const evictedIndices = new Set<number>();
	const evictedToolCallIds = new Set<string>();
	let compactedCount = 0;
	let assistantArgsCompactedCount = 0;
	let evictedCount = 0;
	let anyChanged = false;

	for (let i = 0; i < totalMessages; i++) {
		const msg = messages[i];

		// --- System messages: never touched ---
		if (msg.role === "system") {
			compactedMessages.push(msg);
			continue;
		}

		const distance = totalMessages - 1 - i;

		// --- User messages ---
		if (msg.role === "user") {
			const factor = computeCompactionFactor(distance, multiplier, DEFAULT_MAX_DISTANCE);
			if (factor >= 1.0) {
				evictedIndices.add(i);
				evictedCount++;
				anyChanged = true;
			} else {
				compactedMessages.push(msg);
			}
			continue;
		}

		// --- Assistant messages ---
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const factor = computeCompactionFactor(distance, multiplier, DEFAULT_MAX_DISTANCE);

			if (factor >= 1.0) {
				evictedIndices.add(i);
				evictedCount++;
				anyChanged = true;
				continue;
			}

			// Args compaction (only when factor < 1.0)
			if (!assistantMsg.tool_calls?.length) {
				compactedMessages.push(msg);
				continue;
			}

			let anyArgModified = false;
			const clonedCalls = assistantMsg.tool_calls.map((tc) => {
				const info = toolCallMap.get(tc.id);
				const tool = info?.tool;
				if (!tool) return tc;
				if (tool.argsThreshold === undefined) return tc;
				if (!tool.compactArgs) return tc;

				// Use the paired tool message's factor
				const paired = toolFactors.get(tc.id);
				if (!paired) return tc;
				const { factor: pairedFactor } = paired;

				// Only compact args when factor > argsThreshold AND factor < 1.0 (not evicted)
				if (pairedFactor <= tool.argsThreshold || pairedFactor >= 1.0) return tc;

				let args: Record<string, unknown>;
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					return tc;
				}

				const compactedArgs = tool.compactArgs(args);
				const compactedJson = JSON.stringify(compactedArgs);
				const originalJson = tc.function.arguments;

				if (originalJson.length - compactedJson.length >= MIN_COMPACTION_SAVINGS) {
					anyArgModified = true;
					const saved = originalJson.length - compactedJson.length;
					// Record savedArgsChars (detail will be completed when we process the tool message)
					const existing = details.get(tc.id);
					if (existing) {
						existing.savedArgsChars = saved;
					} else {
						const toolInfo = toolFactors.get(tc.id);
						details.set(tc.id, {
							distance: totalMessages - 1 - (toolInfo ? i : i),
							compactionFactor: toolInfo?.factor ?? 0,
							maxDistance: toolInfo?.maxDist ?? DEFAULT_MAX_DISTANCE,
							outputThreshold: tool.outputThreshold,
							argsThreshold: tool.argsThreshold,
							wasCompacted: false,
							wasEvicted: false,
							savedChars: 0,
							savedArgsChars: saved,
						});
					}
					return {
						...tc,
						function: { ...tc.function, arguments: compactedJson },
					};
				}
				return tc;
			});

			if (anyArgModified) {
				assistantArgsCompactedCount++;
				anyChanged = true;
				compactedMessages.push({ ...assistantMsg, tool_calls: clonedCalls });
			} else {
				compactedMessages.push(msg);
			}
			continue;
		}

		// --- Tool messages ---
		if (msg.role === "tool") {
			const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
			const info = toolCallMap.get(toolMsg.tool_call_id);
			const toolName = info?.toolName ?? "unknown";
			const tool = info?.tool;
			const callArgs = info?.callArgs ?? {};
			const maxDist = tool?.maxDistance ?? DEFAULT_MAX_DISTANCE;
			const factor = toolFactors.get(toolMsg.tool_call_id)?.factor ?? computeCompactionFactor(distance, multiplier, maxDist);

			// Preserve savedArgsChars from assistant argument compaction if already recorded.
			const priorDetail = details.get(toolMsg.tool_call_id);
			const savedArgsChars = priorDetail?.savedArgsChars ?? 0;

			// Factor >= 1.0 → evict
			if (factor >= 1.0) {
				evictedIndices.add(i);
				evictedToolCallIds.add(toolMsg.tool_call_id);
				evictedCount++;
				anyChanged = true;
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool?.outputThreshold,
					argsThreshold: tool?.argsThreshold,
					wasCompacted: false,
					wasEvicted: true,
					savedChars: 0,
					savedArgsChars,
				});
				continue;
			}

			// No outputThreshold → never compacted
			if (!tool || tool.outputThreshold === undefined) {
				compactedMessages.push(msg);
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool?.outputThreshold,
					argsThreshold: tool?.argsThreshold,
					wasCompacted: false,
					wasEvicted: false,
					savedChars: 0,
					savedArgsChars,
				});
				continue;
			}

			// Factor below outputThreshold → no compaction
			if (factor <= tool.outputThreshold) {
				compactedMessages.push(msg);
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool.outputThreshold,
					argsThreshold: tool.argsThreshold,
					wasCompacted: false,
					wasEvicted: false,
					savedChars: 0,
					savedArgsChars,
				});
				continue;
			}

			// Tool has outputThreshold but no compact() method → programming error
			if (!tool.compact) {
				console.warn(
					`[compaction] Tool "${toolName}" has outputThreshold=${tool.outputThreshold} but no compact() method — skipping`,
				);
				compactedMessages.push(msg);
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool.outputThreshold,
					argsThreshold: tool.argsThreshold,
					wasCompacted: false,
					wasEvicted: false,
					savedChars: 0,
					savedArgsChars,
				});
				continue;
			}

			// Call tool.compact()
			const compacted = tool.compact(toolMsg.content, callArgs, {
				sessionId: sessionId ?? "",
				toolCallId: toolMsg.tool_call_id,
			});

			// Only apply compaction if it saves enough characters
			if (toolMsg.content.length - compacted.length >= MIN_COMPACTION_SAVINGS) {
				compactedCount++;
				anyChanged = true;
				compactedMessages.push({
					role: "tool",
					content: compacted,
					tool_call_id: toolMsg.tool_call_id,
				});
				if (toolName === "read_file" && options.onReadFileCompacted) {
					options.onReadFileCompacted(toolMsg.tool_call_id);
				}
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool.outputThreshold,
					argsThreshold: tool.argsThreshold,
					wasCompacted: true,
					wasEvicted: false,
					savedChars: toolMsg.content.length - compacted.length,
					savedArgsChars,
				});
			} else {
				compactedMessages.push(msg);
				details.set(toolMsg.tool_call_id, {
					distance,
					compactionFactor: factor,
					maxDistance: maxDist,
					outputThreshold: tool.outputThreshold,
					argsThreshold: tool.argsThreshold,
					wasCompacted: false,
					wasEvicted: false,
					belowMinSavings: true,
					savedChars: 0,
					savedArgsChars,
				});
			}
			continue;
		}

		// Unknown role — pass through
		compactedMessages.push(msg);
	}

	// If nothing was actually changed, return the original array reference.
	if (!anyChanged) {
		return {
			messages,
			preEviction: messages,
			stats: { compacted: 0, assistantArgsCompacted: 0, evicted: 0, totalToolMessages },
			details,
		};
	}

	// ===== Phase 3: Eviction cleanup =====
	// preEviction = compacted but not evicted (add back evicted messages in order)
	// We rebuild from scratch using the same compaction logic but without eviction.
	const preEviction = buildPreEvictionArray(messages, compactedMessages, evictedIndices, details, toolCallMap);

	// For final messages: remove evicted tool_calls from surviving assistant messages,
	// and remove assistant messages that end up empty.
	const finalMessages: Message[] = [];

	// First pass: determine which assistant messages need tool_call filtering
	// We work on compactedMessages (which already excludes evicted messages)
	for (const msg of compactedMessages) {
		if (msg.role !== "assistant") {
			finalMessages.push(msg);
			continue;
		}

		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls?.length) {
			finalMessages.push(msg);
			continue;
		}

		// Filter out tool_calls whose tool results were evicted
		const remainingCalls = assistantMsg.tool_calls.filter((tc) => !evictedToolCallIds.has(tc.id));

		if (remainingCalls.length === assistantMsg.tool_calls.length) {
			// No calls removed
			finalMessages.push(msg);
		} else if (remainingCalls.length === 0 && !assistantMsg.content) {
			// All calls removed AND no text content → evict assistant too
			evictedCount++;
			anyChanged = true;
		} else {
			// Some calls removed, or all removed but has content
			anyChanged = true;
			finalMessages.push({
				...assistantMsg,
				tool_calls: remainingCalls.length > 0 ? remainingCalls : undefined,
			});
		}
	}

	return {
		messages: finalMessages,
		preEviction,
		stats: {
			compacted: compactedCount,
			assistantArgsCompacted: assistantArgsCompactedCount,
			evicted: evictedCount,
			totalToolMessages,
		},
		details,
	};
}

/**
 * Build the preEviction array: compacted messages (args+output) with NO eviction.
 * This reconstructs what the messages look like after compaction but before any eviction.
 */
function buildPreEvictionArray(
	originalMessages: Message[],
	compactedMessages: Message[],
	evictedIndices: Set<number>,
	_details: Map<string, CompactionDetail>,
	_toolCallMap: Map<
		string,
		{ toolName: string; tool: Tool | undefined; callArgs: Record<string, unknown>; assistantIndex: number }
	>,
): Message[] {
	if (evictedIndices.size === 0) {
		// No eviction happened — compactedMessages IS the preEviction array
		return compactedMessages;
	}

	// We need to merge: for non-evicted indices, use the compacted version;
	// for evicted indices, use the original message.
	const result: Message[] = [];
	let compactedIdx = 0;

	for (let i = 0; i < originalMessages.length; i++) {
		if (evictedIndices.has(i)) {
			// This message was evicted — include the original in preEviction
			result.push(originalMessages[i]);
		} else {
			// This message was NOT evicted — use the compacted version
			result.push(compactedMessages[compactedIdx]);
			compactedIdx++;
		}
	}

	return result;
}
