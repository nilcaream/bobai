import type { ApiFamily } from "./backend-policy";
import type { InterleavedChatReasoningField } from "./provider";
import type { ProviderId } from "./providers";

export type ReasoningCapabilityFamily = "none" | "openai-responses" | "openai-chat-interleaved" | "anthropic-thinking";

export type ReasoningAssistantField = InterleavedChatReasoningField;

export interface ReasoningCapabilities {
	family: ReasoningCapabilityFamily;
	supportsReplay: boolean;
	assistantField?: ReasoningAssistantField;
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
	// OpenRouter normalizes deepseek reasoning to "reasoning" field (not "reasoning_content").
	// Place this BEFORE the general deepseek- quirk so it matches first for openrouter provider.
	{
		providerId: "openrouter",
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)deepseek-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
			assistantField: "reasoning",
		},
	},
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)deepseek-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
			assistantField: "reasoning_content",
		},
	},
	{
		providerId: "opencode-go",
		apiFamily: "openai-chat-completions",
		modelPattern: /^kimi-/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
			assistantField: "reasoning",
		},
	},
	{
		providerId: "opencode-zen",
		apiFamily: "openai-chat-completions",
		modelPattern: /^qwen/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
			assistantField: "reasoning_details",
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
			assistantField: "reasoning",
		},
	},
	{
		apiFamily: "openai-chat-completions",
		modelPattern: /(^|\/)qwen/,
		capabilities: {
			family: "openai-chat-interleaved",
			supportsReplay: true,
			assistantField: "reasoning_details",
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
