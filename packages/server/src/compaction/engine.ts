import type { AssistantMessage, Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import { defaultCompact } from "./default-strategy";
import { computeContextPressure, computeMessageStrengths, DEFAULT_RESISTANCE, type StrengthContext } from "./strength";
import { buildSupersessionMap, detectSupersessions, SUPERSESSION_STRENGTH_BOOST, supersededMarker } from "./supersession";

export interface CompactionOptions {
	/** Full message array (as loaded from DB). */
	messages: Message[];
	/** Context information for strength calculation. */
	context: StrengthContext;
	/** Tool registry to look up compaction resistance and custom compact methods. */
	tools: ToolRegistry;
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
 * (detected by heuristic rules) are compacted more aggressively — even when
 * context pressure is below threshold.
 *
 * System, user, and assistant messages are never modified.
 *
 * This is a pure function — the input array is not mutated.
 */
export function compactMessages(options: CompactionOptions): Message[] {
	const { messages, context, tools } = options;

	// Supersession detection runs unconditionally — it's about semantic
	// relevance, not context pressure.
	const supersessions = detectSupersessions(messages);
	const supersessionMap = buildSupersessionMap(supersessions);

	const contextPressure = computeContextPressure(context);

	// No compaction needed and no supersessions → pass through
	if (contextPressure <= 0 && supersessionMap.size === 0) return messages;

	const toolCallMap = buildToolCallMap(messages, tools);
	const callArgsMap = buildCallArgsMap(messages);

	// Compute base strengths (may be empty if no context pressure)
	const strengths =
		contextPressure > 0
			? computeMessageStrengths(messages, contextPressure, (toolCallId: string) => {
					return toolCallMap.get(toolCallId)?.resistance ?? DEFAULT_RESISTANCE;
				})
			: new Map<number, number>();

	// Nothing to compact and no supersessions
	if (strengths.size === 0 && supersessionMap.size === 0) return messages;

	const result: Message[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;

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

		if (supersessionReason !== undefined) {
			// Superseded message: if we have context pressure, boost the strength
			// and apply normal compaction. If no pressure, use the superseded marker.
			if (baseStrength !== undefined && baseStrength > 0) {
				const boostedStrength = Math.min(1, baseStrength * SUPERSESSION_STRENGTH_BOOST);
				const tool = tools.get(toolName);
				const compacted = tool?.compact
					? tool.compact(toolMsg.content, boostedStrength, callArgs)
					: defaultCompact(toolMsg.content, boostedStrength, toolName);
				result.push({ role: "tool", content: compacted, tool_call_id: toolMsg.tool_call_id });
			} else {
				// No pressure but still superseded → replace with marker
				result.push({
					role: "tool",
					content: supersededMarker(toolName, supersessionReason),
					tool_call_id: toolMsg.tool_call_id,
				});
			}
			continue;
		}

		if (baseStrength === undefined || baseStrength <= 0) {
			// Not superseded and no compaction needed
			result.push(msg);
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

		result.push({
			role: "tool",
			content: compacted,
			tool_call_id: toolMsg.tool_call_id,
		});
	}

	return result;
}
