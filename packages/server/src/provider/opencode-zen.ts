import type { Logger } from "../log/logger";
import { createAnthropicCompatibleProvider } from "./anthropic-compatible";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import { createOpenAIResponsesCompatibleProvider } from "./openai-responses-compatible";
import { getOpenCodeZenApiFamily } from "./opencode-routing";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";

export interface OpenCodeZenAuth {
	apiKey: string;
}

export function createOpenCodeZenProvider(
	auth: OpenCodeZenAuth,
	logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	const chatProvider = createOpenAIChatCompatibleProvider(
		{
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/chat/completions",
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
		configDir,
	);
	const messagesProvider = createAnthropicCompatibleProvider(
		{
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/messages",
			apiKey: auth.apiKey,
			anthropicVersion: "2023-06-01",
		},
		logger,
		fetchFn,
		configDir,
	);
	const responsesProvider = createOpenAIResponsesCompatibleProvider(
		{
			providerId: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1/responses",
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
		configDir,
	);

	return {
		id: "opencode-zen",
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const family = getOpenCodeZenApiFamily(options.model);
			const provider =
				family === "anthropic-messages" ? messagesProvider : family === "openai-responses" ? responsesProvider : chatProvider;
			yield* provider.stream(options);
		},
	};
}
