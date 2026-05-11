import type { Logger } from "../log/logger";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import type { ProviderId } from "./providers";
import { getReasoningCapabilities } from "./reasoning-capabilities";
import { convertMessagesToResponses, convertToolsToResponses } from "./responses-convert";
import { parseResponsesSSE } from "./responses-stream";

function estimatePromptChars(messages: ProviderOptions["messages"]): number {
	return messages.reduce((sum, message) => {
		let s = sum;
		if (typeof message.content === "string") s += message.content.length;
		if ("reasoning" in message && Array.isArray(message.reasoning)) {
			for (const r of message.reasoning) {
				if (r.text) s += r.text.length;
				if (r.summary) s += r.summary.length;
			}
		}
		return s;
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
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	return {
		id: config.providerId,
		configDir,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const reasoningCapabilities = getReasoningCapabilities({
				providerId: config.providerId,
				modelId: options.model,
				apiFamily: "openai-responses",
			});
			const input = convertMessagesToResponses(options.messages, reasoningCapabilities);
			const tools = options.tools?.length ? convertToolsToResponses(options.tools) : undefined;
			const promptChars = estimatePromptChars(options.messages);
			const tokenLimit = getProviderModelConfig(config.providerId, options.model, configDir)?.contextWindow ?? 0;
			let completedUsage = {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				cachedInputTokens: undefined as number | undefined,
			};

			const response = await fetchFn(config.baseUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
					...(config.headers ?? {}),
					...(options.sessionId
						? {
								[config.providerId.startsWith("opencode") ? "x-opencode-session" : "x-session-affinity"]:
									options.sessionId.substring(0, 8),
							}
						: {}),
				},
				body: JSON.stringify({
					model: options.model,
					input,
					max_output_tokens: options.maxOutputTokens,
					stream: true,
					reasoning: { effort: "medium", summary: "auto" },
					include: ["reasoning.encrypted_content"],
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

			for await (const event of parseResponsesSSE(response.body, options.model, configDir, {
				providerId: config.providerId,
				tokenLimit,
				display: formatProviderModelDisplay(
					config.providerId,
					options.model,
					0,
					configDir,
					options.contextLimit,
					options.sessionCostDisplay,
				),
				onCompletedUsage: (usage) => {
					completedUsage = usage;
				},
			})) {
				if (event.type === "usage") {
					yield {
						...event,
						display: formatProviderModelDisplay(
							config.providerId,
							options.model,
							completedUsage.inputTokens,
							configDir,
							options.contextLimit,
							options.sessionCostDisplay,
						),
					};
					options.onMetrics?.({
						model: options.model,
						promptTokens: completedUsage.inputTokens,
						outputTokens: completedUsage.outputTokens,
						promptChars,
						totalTokens: completedUsage.totalTokens,
						cachedInputTokens: completedUsage.cachedInputTokens,
					});
				} else {
					yield event;
				}
			}
		},
	};
}
