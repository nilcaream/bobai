import type { Logger } from "../log/logger";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import type { ProviderId } from "./providers";
import { convertMessagesToResponses, convertToolsToResponses } from "./responses-convert";
import { parseResponsesSSE } from "./responses-stream";

function estimatePromptChars(messages: ProviderOptions["messages"]): number {
	return messages.reduce((sum, message) => {
		if (typeof message.content === "string") return sum + message.content.length;
		return sum;
	}, 0);
}

export interface OpenAIResponsesCompatibleProviderOptions {
	providerId: ProviderId;
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
}

export function createOpenAIResponsesCompatibleProvider(
	config: OpenAIResponsesCompatibleProviderOptions,
	_logger?: Logger,
): Provider {
	return {
		id: config.providerId,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const input = convertMessagesToResponses(options.messages);
			const tools = options.tools?.length ? convertToolsToResponses(options.tools) : undefined;
			const promptChars = estimatePromptChars(options.messages);
			const tokenLimit = getProviderModelConfig(config.providerId, options.model)?.contextWindow ?? 0;
			let completedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

			const response = await fetch(config.baseUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
					...(config.headers ?? {}),
				},
				body: JSON.stringify({
					model: options.model,
					input,
					stream: true,
					...(tools ? { tools } : {}),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}
			if (!response.body) {
				yield { type: "finish", reason: "stop" };
				return;
			}

			for await (const event of parseResponsesSSE(response.body, options.model, options.initiator ?? "user", "", {
				tokenLimit,
				display: formatProviderModelDisplay(config.providerId, options.model, 0),
				onCompletedUsage: (usage) => {
					completedUsage = usage;
				},
			})) {
				if (event.type === "usage") {
					yield {
						...event,
						display: formatProviderModelDisplay(config.providerId, options.model, completedUsage.inputTokens),
					};
					options.onMetrics?.({
						model: options.model,
						promptTokens: completedUsage.inputTokens,
						outputTokens: completedUsage.outputTokens,
						promptChars,
						totalTokens: completedUsage.totalTokens,
						initiator: options.initiator ?? "user",
					});
				} else {
					yield event;
				}
			}
		},
	};
}
