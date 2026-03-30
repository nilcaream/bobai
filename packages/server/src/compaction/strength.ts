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

/** Default threshold: compaction activates when context usage exceeds 50%. */
export const DEFAULT_THRESHOLD = 0.5;

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
 * Position in the conversation (0.0-1.0, from oldest to newest) where the
 * age curve transitions from "mostly compactable" to "mostly protected".
 * At 0.8 the newest 20% of messages are strongly protected.
 */
export const AGE_INFLECTION = 0.8;

/**
 * Controls steepness of the S-curve around the inflection point.
 * Higher values produce a sharper transition; 10 gives a sharp gradient
 * spanning roughly 10% of the conversation on each side of the inflection.
 */
export const AGE_STEEPNESS = 10;

/**
 * Compute the age factor for a tool message (0.0-1.0).
 * Uses an arctan S-curve centered at {@link AGE_INFLECTION} so that messages
 * beyond the inflection (older) are aggressively compactable while messages
 * before it (newer) are strongly protected.
 *
 * @param messageIndex - Zero-based index in the full message array
 * @param totalMessages - Total number of messages in the conversation
 */
export function computeAge(messageIndex: number, totalMessages: number): number {
	if (totalMessages <= 1) return 0;
	const position = messageIndex / (totalMessages - 1); // 0 = oldest, 1 = newest
	const raw = Math.atan(AGE_STEEPNESS * (AGE_INFLECTION - position));
	const rawMin = Math.atan(AGE_STEEPNESS * (AGE_INFLECTION - 1)); // at position = 1
	const rawMax = Math.atan(AGE_STEEPNESS * AGE_INFLECTION); // at position = 0
	return (raw - rawMin) / (rawMax - rawMin);
}

/** Default compaction resistance for tools that don't declare one. */
export const DEFAULT_RESISTANCE = 0.3;

/**
 * Compute the final compaction strength for a single tool message.
 *
 * strength = contextPressure × age × compactability
 *
 * The multiplicative formula ensures that recent messages (age ≈ 0) have
 * near-zero strength regardless of tool resistance, while old messages
 * with low resistance are compacted aggressively.
 *
 * @param contextPressure - Effective context pressure (0.0-1.0), from computeContextPressure()
 * @param age - Message age factor (0.0-1.0), from computeAge()
 * @param resistance - Tool's compaction resistance (0.0-1.0)
 * @returns Compaction strength from 0.0 (no compaction) to 1.0 (maximum compaction)
 */
export function computeStrength(contextPressure: number, age: number, resistance: number): number {
	if (contextPressure <= 0) return 0;
	const compactability = 1 - resistance;
	return Math.min(1, contextPressure * age * compactability);
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
