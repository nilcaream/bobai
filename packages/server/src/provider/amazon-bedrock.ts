import type { AmazonBedrockAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { createBedrockConverseProvider } from "./bedrock-converse";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";

export function createAmazonBedrockProvider(
	auth: AmazonBedrockAuth,
	logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	const converseProvider = createBedrockConverseProvider(auth, logger, fetchFn, configDir);

	return {
		id: "amazon-bedrock",
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield* converseProvider.stream(options);
		},
	};
}
