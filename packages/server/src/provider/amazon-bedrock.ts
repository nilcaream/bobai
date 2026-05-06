import type { AmazonBedrockAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { createAnthropicCompatibleProvider } from "./anthropic-compatible";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";

function bedrockAnthropicUrl(region: string): string {
	return `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`;
}

function bedrockChatUrl(region: string): string {
	return `https://bedrock-mantle.${region}.api.aws/v1/chat/completions`;
}

function isAnthropicModel(modelId: string): boolean {
	return modelId.startsWith("anthropic.");
}

export function createAmazonBedrockProvider(
	auth: AmazonBedrockAuth,
	logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	const messagesProvider = createAnthropicCompatibleProvider(
		{
			providerId: "amazon-bedrock",
			baseUrl: bedrockAnthropicUrl(auth.region),
			apiKey: auth.apiKey,
			anthropicVersion: "2023-06-01",
		},
		logger,
		fetchFn,
		configDir,
	);
	const chatProvider = createOpenAIChatCompatibleProvider(
		{
			providerId: "amazon-bedrock",
			baseUrl: bedrockChatUrl(auth.region),
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
		configDir,
	);

	return {
		id: "amazon-bedrock",
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const provider = isAnthropicModel(options.model) ? messagesProvider : chatProvider;
			yield* provider.stream(options);
		},
	};
}
