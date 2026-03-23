import type { AssistantMessage, Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import { defaultCompact } from "./default-strategy";
import {
	computeAge,
	computeContextPressure,
	computeMessageStrengths,
	DEFAULT_RESISTANCE,
	type StrengthContext,
} from "./strength";
import { buildSupersessionMap, detectSupersessions, SUPERSESSION_STRENGTH_BOOST } from "./supersession";

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
	/** Tool registry to look up compaction resistance and custom compact methods. */
	tools: ToolRegistry;
}

/** Statistics about what the compaction engine did on a given run. */
export interface CompactionStats {
	/** Number of tool messages that were compacted (including superseded). */
	compacted: number;
	/** Number of tool messages that were superseded by heuristic rules. */
	superseded: number;
	/** Context pressure at time of compaction (0.0-1.0). */
	contextPressure: number;
	/** Total tool messages in the input. */
	totalToolMessages: number;
}

/** Per-message compaction decision detail, keyed by tool_call_id. */
export interface CompactionDetail {
	/** Quadratic age factor (0.0-1.0). Higher = older. */
	age: number;
	/** Tool's declared compaction resistance (0.0-1.0). */
	resistance: number;
	/** Final compaction strength before any supersession boost (0.0-1.0). */
	strength: number;
	/** Whether this message's content was actually modified by compaction. */
	wasCompacted: boolean;
	/** If superseded, the reason string from the supersession detector. */
	supersededReason?: string;
	/** If compaction was skipped because savings were below MIN_COMPACTION_SAVINGS. */
	belowMinSavings?: boolean;
}

/**
 * Build a lookup from tool_call_id → { toolName, resistance } by walking
 * assistant messages that contain tool_calls.
 */
function buildToolCallMap(messages: Message[], tools: ToolRegistry): Map<string, { toolName: string; resistance: number }> {
	const map = new Map<string, { toolName: string; resistance: number }>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls) continue;

		for (const tc of assistantMsg.tool_calls) {
			const tool = tools.get(tc.function.name);
			map.set(tc.id, {
				toolName: tc.function.name,
				resistance: tool?.compactionResistance ?? DEFAULT_RESISTANCE,
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
 * their strength (context pressure × age × resistance). Superseded messages
 * (detected by heuristic rules) receive a strength boost and are compacted
 * more aggressively.
 *
 * All compaction — including supersession — is gated behind context pressure.
 * When pressure is zero the full conversation is more valuable to the LLM
 * than saving tokens.
 *
 * System, user, and assistant messages are never modified.
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
	const { messages, context, tools } = options;

	const contextPressure = computeContextPressure(context);

	// Count total tool messages for stats
	const totalToolMessages = messages.filter((m) => m.role === "tool").length;
	const emptyStats: CompactionStats = {
		compacted: 0,
		superseded: 0,
		contextPressure,
		totalToolMessages,
	};

	// No pressure → return everything unchanged. The LLM benefits from the
	// full context when there is room in the window.
	if (contextPressure <= 0) {
		return { messages, stats: emptyStats, details: new Map() };
	}

	// Supersession detection only runs when there is pressure.
	const supersessions = detectSupersessions(messages);
	const supersessionMap = buildSupersessionMap(supersessions);

	const toolCallMap = buildToolCallMap(messages, tools);
	const callArgsMap = buildCallArgsMap(messages);

	const strengths = computeMessageStrengths(messages, contextPressure, (toolCallId: string) => {
		return toolCallMap.get(toolCallId)?.resistance ?? DEFAULT_RESISTANCE;
	});

	// Nothing to compact — no tool messages with strength and no supersessions.
	if (strengths.size === 0 && supersessionMap.size === 0) {
		return { messages, stats: emptyStats, details: new Map() };
	}

	const result: Message[] = [];
	const details = new Map<string, CompactionDetail>();
	let compactedCount = 0;
	let supersededCount = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		if (msg.role !== "tool") {
			result.push(msg);
			continue;
		}

		const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
		const info = toolCallMap.get(toolMsg.tool_call_id);
		const toolName = info?.toolName ?? "unknown";
		const callArgs = callArgsMap.get(toolMsg.tool_call_id) ?? {};

		const supersessionReason = supersessionMap.get(toolMsg.tool_call_id);
		const baseStrength = strengths.get(i);
		const age = computeAge(i, messages.length);

		if (supersessionReason !== undefined) {
			// Superseded message under pressure: boost the strength and compact.
			const boostedStrength = Math.min(1, (baseStrength ?? 0.5) * SUPERSESSION_STRENGTH_BOOST);
			const tool = tools.get(toolName);
			const compacted = tool?.compact
				? tool.compact(toolMsg.content, boostedStrength, callArgs)
				: defaultCompact(toolMsg.content, boostedStrength, toolName);

			// Only apply compaction if it saves enough characters
			if (toolMsg.content.length - compacted.length >= MIN_COMPACTION_SAVINGS) {
				supersededCount++;
				compactedCount++;
				result.push({ role: "tool", content: compacted, tool_call_id: toolMsg.tool_call_id });
				details.set(toolMsg.tool_call_id, {
					age,
					resistance: info?.resistance ?? DEFAULT_RESISTANCE,
					strength: baseStrength ?? 0.5,
					wasCompacted: true,
					supersededReason: supersessionReason,
				});
			} else {
				result.push(msg);
				details.set(toolMsg.tool_call_id, {
					age,
					resistance: info?.resistance ?? DEFAULT_RESISTANCE,
					strength: baseStrength ?? 0.5,
					wasCompacted: false,
					supersededReason: supersessionReason,
					belowMinSavings: true,
				});
			}
			continue;
		}

		if (baseStrength === undefined || baseStrength <= 0) {
			// Not superseded and no compaction needed
			result.push(msg);
			details.set(toolMsg.tool_call_id, {
				age,
				resistance: info?.resistance ?? DEFAULT_RESISTANCE,
				strength: baseStrength ?? 0,
				wasCompacted: false,
			});
			continue;
		}

		// Normal compaction (not superseded, but has strength)
		const tool = tools.get(toolName);
		let compacted: string;
		if (tool?.compact) {
			compacted = tool.compact(toolMsg.content, baseStrength, callArgs);
		} else {
			compacted = defaultCompact(toolMsg.content, baseStrength, toolName);
		}

		// Only apply compaction if it saves enough characters
		if (toolMsg.content.length - compacted.length >= MIN_COMPACTION_SAVINGS) {
			compactedCount++;
			result.push({
				role: "tool",
				content: compacted,
				tool_call_id: toolMsg.tool_call_id,
			});
			details.set(toolMsg.tool_call_id, {
				age,
				resistance: info?.resistance ?? DEFAULT_RESISTANCE,
				strength: baseStrength,
				wasCompacted: true,
			});
		} else {
			result.push(msg);
			details.set(toolMsg.tool_call_id, {
				age,
				resistance: info?.resistance ?? DEFAULT_RESISTANCE,
				strength: baseStrength,
				wasCompacted: false,
				belowMinSavings: true,
			});
		}
	}

	return {
		messages: result,
		stats: {
			compacted: compactedCount,
			superseded: supersededCount,
			contextPressure,
			totalToolMessages,
		},
		details,
	};
}
