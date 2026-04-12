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

/** Default threshold: compaction activates when context usage exceeds 20%. */
export const DEFAULT_THRESHOLD = 0.2;

/**
 * Compute the effective context pressure (0.0-1.0).
 * Returns 0.0 when usage is below the threshold.
 */
export function computeContextPressure(ctx: StrengthContext): number {
	if (ctx.contextWindow <= 0) return 0;
	const usage = ctx.promptTokens / ctx.contextWindow;
	return pressureFromUsage(usage, ctx.threshold);
}

/** Compute context pressure directly from a usage value (0..1). */
export function pressureFromUsage(usage: number, threshold: number = DEFAULT_THRESHOLD): number {
	if (usage <= threshold) return 0;
	return Math.min(1, (usage - threshold) / (1 - threshold));
}

/**
 * Position in the conversation (0.0-1.0, from oldest to newest) where the
 * age curve transitions from "mostly compactable" to "mostly protected".
 * At 0.7 the newest 30% of messages are strongly protected.
 */
export const AGE_INFLECTION = 0.7;

/**
 * Controls steepness of the S-curve around the inflection point.
 * Higher values produce a sharper transition; 5 gives a moderate gradient
 * spanning roughly 20% of the conversation on each side of the inflection.
 */
export const AGE_STEEPNESS = 5;

/**
 * Maximum distance (in messages) from the end of the conversation that
 * contributes to age calculation. Messages further away than this all
 * receive normalizedPosition ≈ 0 → age ≈ 1.0 (fully compactable).
 *
 * This prevents the age window from stretching with conversation length:
 * in a 500-message conversation, the newest 100 messages get a graduated
 * protection curve while everything older is equally compactable.
 */
export const MAX_AGE_DISTANCE = 100;

/**
 * Compute the age factor for a tool message (0.0-1.0).
 * Uses distance-from-end (capped at {@link MAX_AGE_DISTANCE}) and an arctan
 * S-curve centered at {@link AGE_INFLECTION} so that messages beyond the
 * inflection (older) are aggressively compactable while messages before it
 * (newer) are strongly protected.
 *
 * @param messageIndex - Zero-based index in the full message array
 * @param totalMessages - Total number of messages in the conversation
 */
export function computeAge(messageIndex: number, totalMessages: number): number {
	if (totalMessages <= 1) return 0;
	const distanceFromEnd = totalMessages - 1 - messageIndex; // 0 = newest
	const normalizedPosition = 1 - Math.min(distanceFromEnd, MAX_AGE_DISTANCE) / MAX_AGE_DISTANCE;
	// normalizedPosition: 0 = oldest (or >= MAX_AGE_DISTANCE away), 1 = newest
	const raw = Math.atan(AGE_STEEPNESS * (AGE_INFLECTION - normalizedPosition));
	const rawMin = Math.atan(AGE_STEEPNESS * (AGE_INFLECTION - 1));
	const rawMax = Math.atan(AGE_STEEPNESS * AGE_INFLECTION);
	return (raw - rawMin) / (rawMax - rawMin);
}

/**
 * Compute the compaction factor for a single tool message.
 *
 * compactionFactor = contextPressure × age
 *
 * @param contextPressure - Effective context pressure (0.0-1.0), from computeContextPressure()
 * @param age - Message age factor (0.0-1.0), from computeAge()
 * @returns Compaction factor from 0.0 (no compaction) to 1.0 (maximum compaction)
 */
export function computeCompactionFactor(contextPressure: number, age: number): number {
	return contextPressure * age;
}

/** Pre-prompt compaction targets this fraction of the context window. */
export const PRE_PROMPT_TARGET = 0.8;

/** Emergency (mid-turn) compaction targets this fraction of the context window. */
export const EMERGENCY_TARGET = 0.9;

/**
 * Compute the character budget for a given context window and target fraction.
 *
 * Uses the session's measured charsPerToken ratio (prompt_chars / prompt_tokens).
 * Returns 0 when no valid ratio is available (signals "skip compaction").
 */
export function computeCharBudget(contextWindow: number, target: number, promptTokens: number, promptChars: number): number {
	if (contextWindow <= 0) return 0;
	const charsPerToken = promptTokens > 0 && promptChars > 0 ? promptChars / promptTokens : 0;
	if (charsPerToken <= 0) return 0;
	return Math.round(contextWindow * target * charsPerToken);
}

/**
 * Compute the total character length of all message data in an array.
 *
 * Counts both the `content` string and any `tool_calls[].function.arguments`
 * on assistant messages — these are the two main variable-size payloads we
 * send to the API. This is consistent with the provider's `turnLastCallChars`
 * measurement, so the derived `charsPerToken` ratio is self-consistent.
 *
 * Does not include tool definitions or per-message framing (role strings,
 * tool_call IDs, JSON structure). Those are roughly constant within a
 * session and contribute a fixed offset to the API's token count.
 */
export function totalContentChars(
	messages: { role?: string; content: string | null | undefined; tool_calls?: { function: { arguments: string } }[] }[],
): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.content) total += msg.content.length;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function.arguments.length;
			}
		}
	}
	return total;
}

/**
 * Compute the minimum distance-from-end at which a message gets compacted,
 * given a context pressure and the tool's compaction threshold.
 *
 * Searches distances from 1 to totalMessages, returning the first distance
 * where pressure × age(distance) > threshold.
 *
 * @returns The minimum distance, or -1 if the threshold is unreachable at current pressure.
 */
export function computeMinimumDistance(pressure: number, threshold: number, totalMessages: number): number {
	if (pressure <= 0 || threshold < 0) return -1;
	// Max possible factor is pressure × age(at MAX_AGE_DISTANCE) ≈ pressure × 1.0
	// Quick check: if pressure × 1.0 <= threshold, it's unreachable
	const maxAge = computeAge(0, MAX_AGE_DISTANCE + 2); // index 0 in a large array → max distance
	if (pressure * maxAge <= threshold) return -1;
	for (let dist = 1; dist <= Math.min(totalMessages, MAX_AGE_DISTANCE); dist++) {
		// Simulate: messageIndex = totalMessages - 1 - dist means distanceFromEnd = dist
		const age = computeAge(totalMessages - 1 - dist, totalMessages);
		if (pressure * age > threshold) return dist;
	}
	return -1;
}
