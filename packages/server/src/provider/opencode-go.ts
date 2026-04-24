import type { Logger } from "../log/logger";
import { createOpenAIChatCompatibleProvider } from "./openai-chat-compatible";
import type { Provider } from "./provider";

export interface OpenCodeGoAuth {
	apiKey: string;
}

export function createOpenCodeGoProvider(auth: OpenCodeGoAuth, logger?: Logger): Provider {
	return createOpenAIChatCompatibleProvider(
		{
			providerId: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			apiKey: auth.apiKey,
		},
		logger,
	);
}
