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
	const threshold = ctx.threshold ?? DEFAULT_THRESHOLD;
	const usage = ctx.promptTokens / ctx.contextWindow;
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

/**
 * Average characters per token used to estimate token counts from raw message
 * content. This is a model-independent approximation — English text with code
 * typically tokenizes at 3–4 characters per token across modern LLMs.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate the effective prompt token count from raw message content.
 *
 * The stored `session.prompt_tokens` reflects the last API call's token count,
 * which was measured against already-compacted messages. After a tab refresh
 * (or any scenario where messages are reloaded from the database), the raw
 * content may be significantly larger than what the stored value suggests,
 * causing the compaction engine to underestimate context pressure and compact
 * too little.
 *
 * This function computes a rough token estimate from the total character length
 * of all message content (divided by {@link CHARS_PER_TOKEN}), then returns the
 * higher of the estimate and the stored value. This ensures compaction is never
 * weaker than what the stored value alone would produce, while correctly
 * increasing pressure when the raw content is larger.
 */
export function estimatePromptTokens(messages: { content: string | null | undefined }[], storedPromptTokens: number): number {
	let totalChars = 0;
	for (const msg of messages) {
		if (msg.content) totalChars += msg.content.length;
	}
	const estimate = Math.round(totalChars / CHARS_PER_TOKEN);
	return Math.max(estimate, storedPromptTokens);
}
