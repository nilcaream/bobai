import type { AssistantMessage, Message } from "../provider/provider";
import type { Tool, ToolRegistry } from "../tool/tool";
import {
	computeAge,
	computeCompactionFactor,
	computeContextPressure,
	MAX_AGE_DISTANCE,
	type StrengthContext,
} from "./strength";

/** Minimum character savings required for compaction to be applied.
 * If compacting saves fewer than this many characters, the original
 * content is kept. Prevents cases where the COMPACTED marker is
 * nearly as long as the original content. */
export const MIN_COMPACTION_SAVINGS = 128;

export interface CompactionOptions {
	/** Full message array (as loaded from DB). */
	messages: Message[];
	/** Context information for strength calculation. */
	context: StrengthContext;
	/** Tool registry to look up compaction thresholds and compact methods. */
	tools: ToolRegistry;
	/** Session identifier passed to tool compact() context (e.g. for task tool). */
	sessionId?: string;
	/** Called when a read_file tool output is compacted, so callers can invalidate FileTime stamps. */
	onReadFileCompacted?(toolCallId: string, callArgs: Record<string, unknown>): void;
}

/** Statistics about what the compaction engine did on a given run. */
export interface CompactionStats {
	/** Number of tool messages that were compacted. */
	compacted: number;
	/** Number of assistant tool_call argument sets that were compacted. */
	assistantArgsCompacted: number;
	/** Context pressure at time of compaction (0.0-1.0). */
	contextPressure: number;
	/** Total tool messages in the input. */
	totalToolMessages: number;
}

/** Per-message compaction decision detail, keyed by tool_call_id. */
export interface CompactionDetail {
	/** Age factor (0.0-1.0). Higher = older. */
	age: number;
	/** Compaction factor = contextPressure × age (0.0-1.0). */
	compactionFactor: number;
	/** Relative position in conversation (0.0 = oldest, 1.0 = newest). */
	position: number;
	/** Normalized position after MAX_AGE_DISTANCE capping (0.0 = oldest/capped, 1.0 = newest). */
	normalizedPosition: number;
	/** Tool's outputThreshold (undefined if tool has none). */
	outputThreshold?: number;
	/** Tool's argsThreshold (undefined if tool has none). */
	argsThreshold?: number;
	/** Whether this message's content was actually modified by compaction. */
	wasCompacted: boolean;
	/** If compaction was skipped because savings were below MIN_COMPACTION_SAVINGS. */
	belowMinSavings?: boolean;
	/** Characters saved by compaction (original.length - compacted.length). Only set when wasCompacted=true. */
	savedChars?: number;
	/** Characters saved by compacting assistant tool_call arguments for this tool_call_id. */
	savedArgsChars?: number;
}

/**
 * Build a lookup from tool_call_id → { toolName, tool } by walking
 * assistant messages that contain tool_calls.
 */
function buildToolCallMap(messages: Message[], tools: ToolRegistry): Map<string, { toolName: string; tool: Tool | undefined }> {
	const map = new Map<string, { toolName: string; tool: Tool | undefined }>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls) continue;

		for (const tc of assistantMsg.tool_calls) {
			const tool = tools.get(tc.function.name);
			map.set(tc.id, {
				toolName: tc.function.name,
				tool,
			});
		}
	}

	return map;
}

/**
 * Build a lookup from tool_call_id → parsed call arguments.
 */
function buildCallArgsMap(messages: Message[]): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls) continue;

		for (const tc of assistantMsg.tool_calls) {
			try {
				map.set(tc.id, JSON.parse(tc.function.arguments));
			} catch {
				map.set(tc.id, {});
			}
		}
	}

	return map;
}

/**
 * Run the compaction engine over a message array.
 *
 * Returns a new message array with tool outputs compacted according to
 * their compaction factor (context pressure × age) and the tool's declared
 * thresholds. Tools without outputThreshold are never compacted. Unknown
 * tools (not in the registry) are never compacted.
 *
 * All compaction is gated behind context pressure. When pressure is zero
 * the full conversation is more valuable to the LLM than saving tokens.
 *
 * System, user, and plain assistant messages are never modified.
 *
 * This is a pure function — the input array is not mutated.
 */
export function compactMessages(options: CompactionOptions): Message[] {
	return compactMessagesInternal(options).messages;
}

/**
 * Same as compactMessages but also returns statistics about what was compacted.
 * Use this when you need observability into compaction decisions.
 */
export function compactMessagesWithStats(options: CompactionOptions): {
	messages: Message[];
	stats: CompactionStats;
	details: Map<string, CompactionDetail>;
} {
	return compactMessagesInternal(options);
}

function compactMessagesInternal(options: CompactionOptions): {
	messages: Message[];
	stats: CompactionStats;
	details: Map<string, CompactionDetail>;
} {
	const { messages, context, tools, sessionId } = options;

	const contextPressure = computeContextPressure(context);

	// Count total tool messages for stats
	const totalToolMessages = messages.filter((m) => m.role === "tool").length;
	const emptyStats: CompactionStats = {
		compacted: 0,
		assistantArgsCompacted: 0,
		contextPressure,
		totalToolMessages,
	};

	// No pressure → return everything unchanged. The LLM benefits from the
	// full context when there is room in the window.
	if (contextPressure <= 0) {
		return { messages, stats: emptyStats, details: new Map() };
	}

	/** Compute position and normalizedPosition for a message at the given index. */
	function positionFields(idx: number): { position: number; normalizedPosition: number } {
		const position = messages.length <= 1 ? 0 : idx / (messages.length - 1);
		const distanceFromEnd = messages.length - 1 - idx;
		const normalizedPosition = 1 - Math.min(distanceFromEnd, MAX_AGE_DISTANCE) / MAX_AGE_DISTANCE;
		return { position, normalizedPosition };
	}

	const toolCallMap = buildToolCallMap(messages, tools);
	const callArgsMap = buildCallArgsMap(messages);

	// ----- Pass 1: compute compactionFactor for every tool message -----
	// We need this first because assistant messages (which precede their
	// paired tool results) use the paired tool message's compactionFactor
	// for argument compaction decisions.
	const toolCompactionFactors = new Map<string, { compactionFactor: number; age: number; index: number }>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "tool") continue;
		const toolMsg = msg as { role: "tool"; tool_call_id: string };
		const age = computeAge(i, messages.length);
		const compactionFactor = computeCompactionFactor(contextPressure, age);
		toolCompactionFactors.set(toolMsg.tool_call_id, { compactionFactor, age, index: i });
	}

	// ----- Pass 2: compact messages -----
	const result: Message[] = [];
	const details = new Map<string, CompactionDetail>();
	let compactedCount = 0;
	let assistantArgsCompactedCount = 0;
	let anyChanged = false;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		// --- Assistant messages: compact tool_call arguments ---
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			if (!assistantMsg.tool_calls?.length) {
				result.push(msg);
				continue;
			}

			let anyArgModified = false;
			const clonedCalls = assistantMsg.tool_calls.map((tc) => {
				const info = toolCallMap.get(tc.id);
				const tool = info?.tool;
				if (!tool) return tc;

				// Check argsThreshold
				if (tool.argsThreshold === undefined) return tc;
				if (!tool.compactArgs) return tc;

				// Use the paired tool message's compactionFactor
				const factors = toolCompactionFactors.get(tc.id);
				if (!factors) return tc;
				const { compactionFactor } = factors;

				if (compactionFactor <= tool.argsThreshold) return tc;

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
					const savedInThisCall = originalJson.length - compactedJson.length;
					// Record savedArgsChars on the detail (or create a placeholder).
					const existing = details.get(tc.id);
					if (existing) {
						existing.savedArgsChars = savedInThisCall;
					} else {
						// Detail will be properly filled when we process the paired tool message.
						const detailFactors = toolCompactionFactors.get(tc.id);
						const pos = positionFields(detailFactors?.index ?? 0);
						details.set(tc.id, {
							age: detailFactors?.age ?? 0,
							compactionFactor: detailFactors?.compactionFactor ?? 0,
							position: pos.position,
							normalizedPosition: pos.normalizedPosition,
							outputThreshold: tool.outputThreshold,
							argsThreshold: tool.argsThreshold,
							wasCompacted: false,
							savedArgsChars: savedInThisCall,
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
				result.push({ ...assistantMsg, tool_calls: clonedCalls });
			} else {
				result.push(msg);
			}
			continue;
		}

		// --- Non-tool, non-assistant messages: pass through ---
		if (msg.role !== "tool") {
			result.push(msg);
			continue;
		}

		// --- Tool messages: compact output ---
		const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
		const info = toolCallMap.get(toolMsg.tool_call_id);
		const toolName = info?.toolName ?? "unknown";
		const tool = info?.tool;
		const callArgs = callArgsMap.get(toolMsg.tool_call_id) ?? {};

		const factors = toolCompactionFactors.get(toolMsg.tool_call_id);
		const age = factors?.age ?? computeAge(i, messages.length);
		const compactionFactor = factors?.compactionFactor ?? computeCompactionFactor(contextPressure, age);

		// Preserve savedArgsChars from assistant argument compaction if already recorded.
		const priorDetail = details.get(toolMsg.tool_call_id);
		const savedArgsChars = priorDetail?.savedArgsChars;

		// No outputThreshold → never compacted
		if (!tool || tool.outputThreshold === undefined) {
			result.push(msg);
			const pos = positionFields(i);
			details.set(toolMsg.tool_call_id, {
				age,
				compactionFactor,
				position: pos.position,
				normalizedPosition: pos.normalizedPosition,
				outputThreshold: tool?.outputThreshold,
				argsThreshold: tool?.argsThreshold,
				wasCompacted: false,
				savedArgsChars,
			});
			continue;
		}

		// compactionFactor below threshold → no compaction
		if (compactionFactor <= tool.outputThreshold) {
			result.push(msg);
			const pos = positionFields(i);
			details.set(toolMsg.tool_call_id, {
				age,
				compactionFactor,
				position: pos.position,
				normalizedPosition: pos.normalizedPosition,
				outputThreshold: tool.outputThreshold,
				argsThreshold: tool.argsThreshold,
				wasCompacted: false,
				savedArgsChars,
			});
			continue;
		}

		// Tool has outputThreshold but no compact() method → programming error
		if (!tool.compact) {
			console.warn(
				`[compaction] Tool "${toolName}" has outputThreshold=${tool.outputThreshold} but no compact() method — skipping`,
			);
			result.push(msg);
			const pos = positionFields(i);
			details.set(toolMsg.tool_call_id, {
				age,
				compactionFactor,
				position: pos.position,
				normalizedPosition: pos.normalizedPosition,
				outputThreshold: tool.outputThreshold,
				argsThreshold: tool.argsThreshold,
				wasCompacted: false,
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
			result.push({
				role: "tool",
				content: compacted,
				tool_call_id: toolMsg.tool_call_id,
			});
			if (toolName === "read_file" && options.onReadFileCompacted) {
				options.onReadFileCompacted(toolMsg.tool_call_id, callArgs);
			}
			const pos = positionFields(i);
			details.set(toolMsg.tool_call_id, {
				age,
				compactionFactor,
				position: pos.position,
				normalizedPosition: pos.normalizedPosition,
				outputThreshold: tool.outputThreshold,
				argsThreshold: tool.argsThreshold,
				wasCompacted: true,
				savedChars: toolMsg.content.length - compacted.length,
				savedArgsChars,
			});
		} else {
			result.push(msg);
			const pos = positionFields(i);
			details.set(toolMsg.tool_call_id, {
				age,
				compactionFactor,
				position: pos.position,
				normalizedPosition: pos.normalizedPosition,
				outputThreshold: tool.outputThreshold,
				argsThreshold: tool.argsThreshold,
				wasCompacted: false,
				belowMinSavings: true,
				savedArgsChars,
			});
		}
	}

	// If nothing was actually changed, return the original array reference.
	if (!anyChanged) {
		return { messages, stats: emptyStats, details };
	}

	return {
		messages: result,
		stats: {
			compacted: compactedCount,
			assistantArgsCompacted: assistantArgsCompactedCount,
			contextPressure,
			totalToolMessages,
		},
		details,
	};
}
