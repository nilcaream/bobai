import type { ApiFamily } from "./backend-policy";
import type { InterleavedChatReasoningField } from "./provider";
import type { ProviderId } from "./providers";

export type ReasoningCapabilityFamily = "none" | "openai-responses" | "openai-chat-interleaved" | "anthropic-thinking";

/** @deprecated Field name is now auto-detected from the stream. */
export type ReasoningAssistantField = InterleavedChatReasoningField;

export interface ReasoningCapabilities {
	family: ReasoningCapabilityFamily;
	supportsReplay: boolean;
	requiresEmptyAssistantReasoningFields?: boolean;
}

export interface ReasoningCapabilityResolverOptions {
	providerId: ProviderId;
	modelId: string;
	apiFamily: ApiFamily;
}

interface ReasoningQuirk {
	providerId?: ProviderId;
	apiFamily?: ApiFamily;
	modelPattern: RegExp;
	capabilities: Partial<ReasoningCapabilities> & Pick<ReasoningCapabilities, "family">;
}

const QUIRKS: ReasoningQuirk[] = [
	// OpenRouter normalizes deepseek reasoning — detect from stream.
	{
		providerId: "openrouter",
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)deepseek-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)deepseek-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	{
		providerId: "opencode-go",
		apiFamily: "openai-chat-completions",
		modelPattern: /^kimi-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	{
		providerId: "opencode-zen",
		apiFamily: "openai-chat-completions",
		modelPattern: /^qwen/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	// OpenRouter normalizes gemini reasoning — detect from stream.
	{
		providerId: "openrouter",
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)gemini-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	// Gemini models.
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)gemini-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	// OpenRouter-proxied models — no providerId constraint so they match
	// regardless of which provider routes the request.
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)kimi-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)qwen/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
		},
	},
];

export function getReasoningCapabilities(options: ReasoningCapabilityResolverOptions): ReasoningCapabilities {
	const quirk = QUIRKS.find(
		(candidate) =>
			(candidate.providerId === undefined || candidate.providerId === options.providerId) &&
			(candidate.apiFamily === undefined || candidate.apiFamily === options.apiFamily) &&
			candidate.modelPattern.test(options.modelId),
	);
	if (quirk) {
		return {
			...getDefaultReasoningCapabilities(options.apiFamily),
			...quirk.capabilities,
		};
	}

	return getDefaultReasoningCapabilities(options.apiFamily);
}

/**
 * The `reasoning_effort` value to send for the OpenAI chat-completions wire
 * format, or undefined when the model has no explicit effort control.
 *
 * We deliberately never rely on the provider's implicit default: DeepSeek V4
 * auto-bumps agent traffic to `max` effort when the field is omitted, which
 * produces unbounded chain-of-thought (see DeepSeek Thinking Mode docs). We pin
 * reasoning models to their documented "normal" level and add entries here as
 * we verify each provider's native values, rather than guessing.
 */
export function getChatReasoningEffort(providerId: ProviderId, modelId: string): string | undefined {
	const quirk = CHAT_REASONING_EFFORT.find(
		(candidate) =>
			(candidate.providerId === undefined || candidate.providerId === providerId) && candidate.modelPattern.test(modelId),
	);
	return quirk?.effort;
}

interface ChatReasoningEffortQuirk {
	providerId?: ProviderId;
	modelPattern: RegExp;
	/** Value for the top-level `reasoning_effort` field. */
	effort: string;
}

const CHAT_REASONING_EFFORT: ChatReasoningEffortQuirk[] = [
	// DeepSeek V4 in thinking mode supports `high` and `max` (low/medium map to
	// high, xhigh maps to max). Agent requests default to `max`, so pin to `high`.
	{ modelPattern: /deepseek/i, effort: "high" },
];

function getDefaultReasoningCapabilities(apiFamily: ApiFamily): ReasoningCapabilities {
	switch (apiFamily) {
		case "openai-responses":
			return {
				family: "openai-responses",
				supportsReplay: true,
			};
		case "anthropic-messages":
			return {
				family: "anthropic-thinking",
				supportsReplay: false,
			};
		case "openai-chat-completions":
			return {
				family: "none",
				supportsReplay: false,
			};
	}
}
