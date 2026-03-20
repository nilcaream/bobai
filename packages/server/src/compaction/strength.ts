import type { Message } from "../provider/provider";

/**
 * Context about the current session needed for strength calculation.
 */
export interface StrengthContext {
	/** Current prompt token count from the last LLM response. */
	promptTokens: number;
	/** Maximum context window size for the current model. */
	contextWindow: number;
	/** Context pressure threshold below which no compaction occurs (0.0-1.0). */
	threshold?: number;
}

/** Default threshold: compaction activates when context usage exceeds 40%. */
export const DEFAULT_THRESHOLD = 0.4;

/**
 * Compute the effective context pressure (0.0-1.0).
 * Returns 0.0 when usage is below the threshold.
 */
export function computeContextPressure(ctx: StrengthContext): number {
	if (ctx.contextWindow <= 0) return 0;
	const threshold = ctx.threshold ?? DEFAULT_THRESHOLD;
	const usage = ctx.promptTokens / ctx.contextWindow;
	if (usage <= threshold) return 0;
	return Math.min(1, (usage - threshold) / (1 - threshold));
}

/**
 * Compute the age factor for a tool message (0.0-1.0).
 * Older messages approach 1.0; newer messages approach 0.0.
 * Only tool messages have meaningful age — system/user/assistant messages return 0.
 *
 * @param messageIndex - Zero-based index in the full message array
 * @param totalMessages - Total number of messages in the conversation
 */
export function computeAge(messageIndex: number, totalMessages: number): number {
	if (totalMessages <= 1) return 0;
	return 1 - messageIndex / (totalMessages - 1);
}

/** Default compaction resistance for tools that don't declare one. */
export const DEFAULT_RESISTANCE = 0.3;

/**
 * Compute the final compaction strength for a single tool message.
 *
 * strength = effective_cp × weighted_average(age, 1 - resistance)
 *
 * @param contextPressure - Effective context pressure (0.0-1.0), from computeContextPressure()
 * @param age - Message age factor (0.0-1.0), from computeAge()
 * @param resistance - Tool's compaction resistance (0.0-1.0)
 * @returns Compaction strength from 0.0 (no compaction) to 1.0 (maximum compaction)
 */
export function computeStrength(contextPressure: number, age: number, resistance: number): number {
	if (contextPressure <= 0) return 0;
	const compactability = 1 - resistance;
	// Weighted average of age and compactability (equal weight)
	const factor = (age + compactability) / 2;
	return Math.min(1, contextPressure * factor);
}

/**
 * Determine which messages are tool messages and compute their strengths.
 * Returns a Map from message index to compaction strength.
 * Non-tool messages are not included (they are never compacted).
 */
export function computeMessageStrengths(
	messages: Message[],
	contextPressure: number,
	getResistance: (toolCallId: string) => number,
): Map<number, number> {
	const strengths = new Map<number, number>();
	const total = messages.length;

	for (let i = 0; i < total; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "tool") continue;

		const toolCallId = (msg as { tool_call_id: string }).tool_call_id;
		const age = computeAge(i, total);
		const resistance = getResistance(toolCallId);
		const strength = computeStrength(contextPressure, age, resistance);

		if (strength > 0) {
			strengths.set(i, strength);
		}
	}

	return strengths;
}
