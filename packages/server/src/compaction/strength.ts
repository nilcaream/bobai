/**
 * Default maxDistance for message roles that are not tools (user, assistant).
 * High value so they survive nearly the entire conversation before eviction.
 */
export const DEFAULT_MAX_DISTANCE = 10_000;

/**
 * Compute the compaction factor for a message using the linear per-tool model.
 *
 * factor = distance / (multiplier × maxDistance), clamped to [0, 1].
 *
 * @param distance - number of messages from the end (last message = 0)
 * @param multiplier - scaling factor from the outer loop (higher = less aggressive)
 * @param maxDistance - per-tool constant: distance at which factor reaches 1.0 when multiplier=1.0
 */
export function computeCompactionFactor(distance: number, multiplier: number, maxDistance: number): number {
	if (multiplier <= 0 || maxDistance <= 0) return 1.0;
	return Math.min(1.0, distance / (multiplier * maxDistance));
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
