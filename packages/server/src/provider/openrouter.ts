import type { OpenRouterAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import type { Provider } from "./provider";

export function createOpenRouterProvider(auth: OpenRouterAuth, logger?: Logger, fetchFn: typeof fetch = fetch): Provider {
	return createOpenAIChatCompatibleProvider(
		{
			providerId: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/chat/completions",
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
	);
}
