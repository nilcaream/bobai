import { isCopilotClaude, isCopilotResponses } from "./copilot";
import { getDefaultModelForProvider, isSupportedProvider, type ProviderId } from "./providers";

export const API_FAMILIES = ["anthropic-messages", "openai-responses", "openai-chat-completions"] as const;

export type ApiFamily = (typeof API_FAMILIES)[number];

export interface SessionBackendState {
	provider: ProviderId;
	model: string;
	apiFamily: ApiFamily;
}

export function getDefaultSessionBackend(providerId: ProviderId): SessionBackendState {
	const model = getDefaultModelForProvider(providerId);
	return {
		provider: providerId,
		model,
		apiFamily: getApiFamilyForModel(providerId, model),
	};
}

export function getApiFamilyForModel(providerId: ProviderId, modelId: string): ApiFamily {
	switch (providerId) {
		case "github-copilot":
			if (isCopilotClaude(modelId)) return "anthropic-messages";
			if (isCopilotResponses(modelId)) return "openai-responses";
			return "openai-chat-completions";
		case "openrouter":
			return "openai-chat-completions";
	}
}

export function isRuntimeSupportedProvider(providerId: string): providerId is ProviderId {
	return isSupportedProvider(providerId);
}

export type BackendTransitionResult = { ok: true; next: SessionBackendState } | { ok: false; error: string };

export function validateProviderSwitch(options: {
	hasMessages: boolean;
	current: SessionBackendState;
	nextProvider: ProviderId;
}): BackendTransitionResult {
	if (options.hasMessages) {
		return { ok: false, error: "Changing provider for a session with messages is not yet supported." };
	}

	if (!isRuntimeSupportedProvider(options.nextProvider)) {
		return { ok: false, error: `Provider runtime is not supported yet: ${options.nextProvider}` };
	}

	return { ok: true, next: getDefaultSessionBackend(options.nextProvider) };
}

export function validateModelSwitch(options: {
	hasMessages: boolean;
	current: SessionBackendState;
	nextModel: string;
}): BackendTransitionResult {
	const nextApiFamily = getApiFamilyForModel(options.current.provider, options.nextModel);
	const next: SessionBackendState = {
		provider: options.current.provider,
		model: options.nextModel,
		apiFamily: nextApiFamily,
	};

	if (options.hasMessages && nextApiFamily !== options.current.apiFamily) {
		return { ok: false, error: "Switching models across API families for a session with messages is not yet supported." };
	}

	return { ok: true, next };
}
