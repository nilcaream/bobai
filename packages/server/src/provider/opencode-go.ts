import type { Logger } from "../log/logger";
import { createAnthropicCompatibleProvider } from "./anthropic-compatible";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";

export interface OpenCodeGoAuth {
	apiKey: string;
}

function isOpenCodeGoMessagesModel(modelId: string): boolean {
	return modelId.startsWith("minimax-");
}

export function createOpenCodeGoProvider(
	auth: OpenCodeGoAuth,
	logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	const chatProvider = createOpenAIChatCompatibleProvider(
		{
			providerId: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
		configDir,
	);
	const messagesProvider = createAnthropicCompatibleProvider(
		{
			providerId: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1/messages",
			apiKey: auth.apiKey,
			anthropicVersion: "2023-06-01",
		},
		logger,
		fetchFn,
		configDir,
	);

	return {
		id: "opencode-go",
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const provider = isOpenCodeGoMessagesModel(options.model) ? messagesProvider : chatProvider;
			yield* provider.stream(options);
		},
	};
}
