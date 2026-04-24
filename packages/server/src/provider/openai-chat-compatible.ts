import type { Logger } from "../log/logger";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import type { ProviderId } from "./providers";
import { parseSSE } from "./sse";

function estimatePromptChars(messages: ProviderOptions["messages"]): number {
	return messages.reduce((sum, message) => {
		if (typeof message.content === "string") return sum + message.content.length;
		return sum;
	}, 0);
}

export interface OpenAIChatCompatibleProviderOptions {
	providerId: ProviderId;
	baseUrl: string;
	apiKey: string;
}

export function createOpenAIChatCompatibleProvider(config: OpenAIChatCompatibleProviderOptions, _logger?: Logger): Provider {
	return {
		id: config.providerId,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const response = await fetch(config.baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model: options.model,
					messages: options.messages,
					stream: true,
					stream_options: { include_usage: true },
					...(options.tools?.length ? { tools: options.tools } : {}),
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

			const promptChars = estimatePromptChars(options.messages);
			let promptTokens = 0;
			let totalTokens = 0;
			let finishReason: "stop" | "tool_calls" = "stop";
			let sawFinish = false;

			for await (const event of parseSSE(response.body)) {
				const data = event as {
					choices?: {
						delta?: {
							content?: string;
							tool_calls?: {
								index: number;
								id?: string;
								type?: string;
								function?: { name?: string; arguments?: string };
							}[];
						};
						finish_reason?: string | null;
					}[];
					usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
				};

				const choice = data.choices?.[0];
				const delta = choice?.delta;

				if (delta?.content) {
					yield { type: "text", text: delta.content };
				}

				for (const toolCall of delta?.tool_calls ?? []) {
					if (toolCall.id && toolCall.function?.name) {
						yield {
							type: "tool_call_start",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function.name,
						};
					}
					if (toolCall.function?.arguments) {
						yield {
							type: "tool_call_delta",
							index: toolCall.index,
							arguments: toolCall.function.arguments,
						};
					}
				}

				if (choice?.finish_reason) {
					promptTokens = data.usage?.prompt_tokens ?? promptTokens;
					totalTokens = data.usage?.total_tokens ?? totalTokens;
					finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
					const tokenLimit = getProviderModelConfig(config.providerId, options.model)?.contextWindow ?? 0;
					const display = formatProviderModelDisplay(config.providerId, options.model, promptTokens);
					yield { type: "usage", tokenCount: promptTokens, tokenLimit, display };
					options.onMetrics?.({
						model: options.model,
						promptTokens,
						outputTokens: Math.max(0, totalTokens - promptTokens),
						promptChars,
						totalTokens,
						initiator: options.initiator ?? "user",
					});
					yield { type: "finish", reason: finishReason };
					sawFinish = true;
				}
			}

			if (!sawFinish) {
				yield { type: "finish", reason: finishReason };
			}
		},
	};
}
