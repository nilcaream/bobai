import type { AssistantMessage, Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import { compactArgument, defaultCompact } from "./default-strategy";
import {
	computeAge,
	computeContextPressure,
	computeMessageStrengths,
	DEFAULT_RESISTANCE,
	type StrengthContext,
} from "./strength";
import { buildSupersessionMap, detectSupersessions, supersededMarker } from "./supersession";

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
	/** Characters saved by compaction (original.length - compacted.length). Only set when wasCompacted=true. */
	savedChars?: number;
	/** Characters saved by compacting assistant tool_call arguments for this tool_call_id. */
	savedArgsChars?: number;
	/** The tool_call_id that supersedes this message. Only set when superseded. */
	supersededBy?: string;
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
 * (detected by heuristic rules) are replaced with a short marker indicating
 * that the output has been superseded.
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
		assistantArgsCompacted: 0,
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

	const supersedingIdMap = new Map<string, string>();
	for (const s of supersessions) {
		if (s.supersedingId) {
			supersedingIdMap.set(s.toolCallId, s.supersedingId);
		}
	}

	const toolCallMap = buildToolCallMap(messages, tools);
	const callArgsMap = buildCallArgsMap(messages);

	const strengths = computeMessageStrengths(messages, contextPressure, (toolCallId: string) => {
		return toolCallMap.get(toolCallId)?.resistance ?? DEFAULT_RESISTANCE;
	});

	// Build tool_call_id → { index, strength } for assistant argument compaction.
	// This lets us look up the strength that would apply to a tool_call's paired response.
	const toolCallStrengths = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.role !== "tool") continue;
		const toolMsg = msg as { role: "tool"; tool_call_id: string };
		const strength = strengths.get(i);
		if (strength !== undefined) {
			toolCallStrengths.set(toolMsg.tool_call_id, strength);
		}
	}

	// Nothing to compact — no tool messages with strength and no supersessions.
	if (strengths.size === 0 && supersessionMap.size === 0) {
		return { messages, stats: emptyStats, details: new Map() };
	}

	const result: Message[] = [];
	const details = new Map<string, CompactionDetail>();
	let compactedCount = 0;
	let supersededCount = 0;
	let assistantArgsCompactedCount = 0;

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
				const tool = tools.get(tc.function.name);
				if (!tool?.compactableArgs?.length) return tc;

				const strength = toolCallStrengths.get(tc.id);
				const isSupersseded = supersessionMap.has(tc.id);

				// No pressure on this call and not superseded → skip
				if ((strength === undefined || strength <= 0) && !isSupersseded) return tc;

				const effectiveStrength = isSupersseded ? Math.max(strength ?? 0, 0.9) : (strength ?? 0);

				let args: Record<string, unknown>;
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					return tc;
				}

				let modified = false;
				let savedInThisCall = 0;
				for (const field of tool.compactableArgs) {
					const val = args[field];
					if (typeof val !== "string") continue;
					const compacted = compactArgument(val, effectiveStrength, tc.function.name, field);
					if (val.length - compacted.length >= MIN_COMPACTION_SAVINGS) {
						savedInThisCall += val.length - compacted.length;
						args[field] = compacted;
						modified = true;
					}
				}

				if (modified) {
					anyArgModified = true;
					// Record savedArgsChars on the existing detail (or create a placeholder).
					const existing = details.get(tc.id);
					if (existing) {
						existing.savedArgsChars = savedInThisCall;
					} else {
						// Detail will be properly filled when we process the paired tool message.
						// Store a partial entry so we don't lose the savings count.
						details.set(tc.id, {
							age: 0,
							resistance: tool.compactionResistance ?? DEFAULT_RESISTANCE,
							strength: effectiveStrength,
							wasCompacted: false,
							savedArgsChars: savedInThisCall,
						});
					}
					return {
						...tc,
						function: { ...tc.function, arguments: JSON.stringify(args) },
					};
				}

				return tc;
			});

			if (anyArgModified) {
				assistantArgsCompactedCount++;
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

		const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
		const info = toolCallMap.get(toolMsg.tool_call_id);
		const toolName = info?.toolName ?? "unknown";
		const callArgs = callArgsMap.get(toolMsg.tool_call_id) ?? {};

		const supersessionReason = supersessionMap.get(toolMsg.tool_call_id);
		const baseStrength = strengths.get(i);
		const age = computeAge(i, messages.length);

		// Preserve savedArgsChars from assistant argument compaction if already recorded.
		const priorDetail = details.get(toolMsg.tool_call_id);
		const savedArgsChars = priorDetail?.savedArgsChars;

		if (supersessionReason !== undefined) {
			// Superseded message: replace with a one-liner marker.
			const marker = supersededMarker(toolName, supersessionReason);

			if (toolMsg.content.length - marker.length >= MIN_COMPACTION_SAVINGS) {
				supersededCount++;
				compactedCount++;
				result.push({ role: "tool", content: marker, tool_call_id: toolMsg.tool_call_id });
				details.set(toolMsg.tool_call_id, {
					age,
					resistance: info?.resistance ?? DEFAULT_RESISTANCE,
					strength: baseStrength ?? 0,
					wasCompacted: true,
					supersededReason: supersessionReason,
					savedChars: toolMsg.content.length - marker.length,
					savedArgsChars,
					supersededBy: supersedingIdMap.get(toolMsg.tool_call_id),
				});
			} else {
				result.push(msg);
				details.set(toolMsg.tool_call_id, {
					age,
					resistance: info?.resistance ?? DEFAULT_RESISTANCE,
					strength: baseStrength ?? 0,
					wasCompacted: false,
					supersededReason: supersessionReason,
					belowMinSavings: true,
					savedArgsChars,
					supersededBy: supersedingIdMap.get(toolMsg.tool_call_id),
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
				savedArgsChars,
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
				savedChars: toolMsg.content.length - compacted.length,
				savedArgsChars,
			});
		} else {
			result.push(msg);
			details.set(toolMsg.tool_call_id, {
				age,
				resistance: info?.resistance ?? DEFAULT_RESISTANCE,
				strength: baseStrength,
				wasCompacted: false,
				belowMinSavings: true,
				savedArgsChars,
			});
		}
	}

	return {
		messages: result,
		stats: {
			compacted: compactedCount,
			superseded: supersededCount,
			assistantArgsCompacted: assistantArgsCompactedCount,
			contextPressure,
			totalToolMessages,
		},
		details,
	};
}
