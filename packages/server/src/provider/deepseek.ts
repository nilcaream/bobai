import type { DeepSeekAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import type { Provider } from "./provider";

export function createDeepSeekProvider(
	auth: DeepSeekAuth,
	logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir?: string,
): Provider {
	return createOpenAIChatCompatibleProvider(
		{
			providerId: "deepseek",
			baseUrl: "https://api.deepseek.com/v1/chat/completions",
			apiKey: auth.apiKey,
		},
		logger,
		fetchFn,
		configDir,
	);
}
