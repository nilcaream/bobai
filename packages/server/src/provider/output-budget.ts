import type { Message } from "./provider";

/**
 * Conservative fallback when no historical prompt token ratio is available.
 * Chosen to over-estimate token usage rather than risk requesting too much output.
 */
export const DEFAULT_FALLBACK_CHARS_PER_TOKEN = 3;

/** Reserve a small amount of output space to avoid boundary overflows from framing/estimation noise. */
export const OUTPUT_TOKEN_HEADROOM = 10;

export interface PromptTokenEstimateOptions {
	messageChars: number;
	sessionPromptTokens?: number;
	sessionPromptChars?: number;
}

export interface SafeMaxOutputTokensOptions extends PromptTokenEstimateOptions {
	contextWindow: number;
	configuredMaxOutput: number;
	headroom?: number;
}

export function estimateMessageChars(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === "string") total += message.content.length;
		if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
			for (const toolCall of message.tool_calls) {
				total += toolCall.function.arguments.length;
			}
		}
		if ("reasoning" in message && Array.isArray(message.reasoning)) {
			for (const r of message.reasoning) {
				if (r.text) total += r.text.length;
				if (r.summary) total += r.summary.length;
			}
		}
	}
	return total;
}

export function computeConservativePromptTokenEstimate(options: PromptTokenEstimateOptions): number {
	const { messageChars, sessionPromptTokens = 0, sessionPromptChars = 0 } = options;
	const charsPerToken =
		sessionPromptTokens > 0 && sessionPromptChars > 0
			? sessionPromptChars / sessionPromptTokens
			: DEFAULT_FALLBACK_CHARS_PER_TOKEN;
	const estimatedFromChars = Math.ceil(messageChars / charsPerToken);
	return Math.max(estimatedFromChars, sessionPromptTokens, 0);
}

export function computeSafeMaxOutputTokens(options: SafeMaxOutputTokensOptions): number {
	const {
		contextWindow,
		configuredMaxOutput,
		messageChars,
		sessionPromptTokens = 0,
		sessionPromptChars = 0,
		headroom = OUTPUT_TOKEN_HEADROOM,
	} = options;

	if (configuredMaxOutput <= 0) return 1;
	if (contextWindow <= 0) return configuredMaxOutput;

	const charsPerToken =
		sessionPromptTokens > 0 && sessionPromptChars > 0
			? sessionPromptChars / sessionPromptTokens
			: DEFAULT_FALLBACK_CHARS_PER_TOKEN;

	let estimatedPromptTokens = computeConservativePromptTokenEstimate({
		messageChars,
		sessionPromptTokens,
		sessionPromptChars,
	});

	// When the estimate (pushed up by a stale sessionPromptTokens floor from
	// a previous turn's larger uncompacted payload) exceeds the context window,
	// fall back to a pure chars-based estimate of the current compacted payload.
	// This preserves the floor in the normal case (where it guards against
	// undercounting) but ignores it when it would consume the entire output budget.
	if (estimatedPromptTokens >= contextWindow - headroom) {
		const charsBased = Math.ceil(messageChars / charsPerToken);
		estimatedPromptTokens = Math.min(estimatedPromptTokens, charsBased);
	}

	const remaining = contextWindow - estimatedPromptTokens - headroom;
	return Math.max(1, Math.min(configuredMaxOutput, remaining));
}
