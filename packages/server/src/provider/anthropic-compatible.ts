import type { Logger } from "../log/logger";
import { convertMessagesToAnthropic, convertToolsToAnthropic } from "./anthropic-convert";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import type { ProviderId } from "./providers";
import { getReasoningCapabilities, type ReasoningCapabilities } from "./reasoning-capabilities";
import { parseSSE } from "./sse";

function estimatePromptChars(messages: ProviderOptions["messages"]): number {
	return messages.reduce((sum, message) => {
		if (typeof message.content === "string") return sum + message.content.length;
		return sum;
	}, 0);
}

export interface AnthropicCompatibleProviderOptions {
	providerId: ProviderId;
	baseUrl: string;
	apiKey: string;
	apiKeyHeader?: "x-api-key" | "Authorization";
	anthropicVersion?: string;
}

interface AnthropicThinkingOptions {
	thinking: {
		type: "enabled";
		budget_tokens: number;
		display: "summarized" | "omitted";
	};
}

export interface AnthropicReasoningDefaults {
	budgetTokens?: number;
	display?: "summarized" | "omitted";
}

const DEFAULT_ANTHROPIC_REASONING_DEFAULTS: Required<AnthropicReasoningDefaults> = {
	budgetTokens: 1024,
	display: "omitted",
};

export function getAnthropicReasoningOptions(
	capabilities: ReasoningCapabilities,
	defaults: AnthropicReasoningDefaults = DEFAULT_ANTHROPIC_REASONING_DEFAULTS,
): AnthropicThinkingOptions | undefined {
	if (capabilities.family !== "anthropic-thinking") {
		return undefined;
	}

	const resolvedDefaults = {
		...DEFAULT_ANTHROPIC_REASONING_DEFAULTS,
		...defaults,
	};

	return {
		thinking: {
			type: "enabled",
			budget_tokens: resolvedDefaults.budgetTokens,
			display: resolvedDefaults.display,
		},
	};
}

export function createAnthropicCompatibleProvider(
	config: AnthropicCompatibleProviderOptions,
	_logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	return {
		id: config.providerId,
		configDir,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const { system, messages } = convertMessagesToAnthropic(options.messages);
			const tools = options.tools?.length ? convertToolsToAnthropic(options.tools) : undefined;
			const maxTokens = options.maxOutputTokens;
			const apiKeyHeader = config.apiKeyHeader ?? "x-api-key";
			const reasoningCapabilities = getReasoningCapabilities({
				providerId: config.providerId,
				modelId: options.model,
				apiFamily: "anthropic-messages",
			});
			const anthropicReasoningOptions = getAnthropicReasoningOptions(
				reasoningCapabilities,
				options.reasoningDefaults?.anthropic,
			);

			const response = await fetchFn(config.baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[apiKeyHeader]: apiKeyHeader === "Authorization" ? `Bearer ${config.apiKey}` : config.apiKey,
					...(config.anthropicVersion ? { "anthropic-version": config.anthropicVersion } : {}),
					...(options.sessionId
						? {
								[config.providerId.startsWith("opencode") ? "x-opencode-session" : "x-session-affinity"]:
									options.sessionId.substring(0, 8),
							}
						: {}),
				},
				body: JSON.stringify({
					model: options.model,
					messages,
					max_tokens: maxTokens,
					stream: true,
					...(system ? { system } : {}),
					...(tools ? { tools } : {}),
					...(anthropicReasoningOptions ?? {}),
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
			let inputTokens = 0;
			let outputTokens = 0;
			let stopReason: string | undefined;
			let didEmitFinish = false;
			let hasReceivedContent = false;
			let sawToolCalls = false;

			for await (const event of parseSSE(response.body)) {
				const raw = event as {
					type?: string;
					index?: number;
					message?: { usage?: { input_tokens?: number } };
					content_block?: { type?: string; id?: string; name?: string };
					delta?: {
						type?: string;
						text?: string;
						partial_json?: string;
						stop_reason?: string;
					};
					usage?: { output_tokens?: number };
				};

				switch (raw.type) {
					case "message_start": {
						inputTokens = raw.message?.usage?.input_tokens ?? 0;
						break;
					}
					case "content_block_start": {
						if (
							raw.content_block?.type === "tool_use" &&
							raw.content_block.id &&
							raw.content_block.name &&
							typeof raw.index === "number"
						) {
							sawToolCalls = true;
							yield {
								type: "tool_call_start",
								index: raw.index,
								id: raw.content_block.id,
								name: raw.content_block.name,
							};
						}
						break;
					}
					case "content_block_delta": {
						if (raw.delta?.type === "text_delta" && raw.delta.text) {
							hasReceivedContent = true;
							yield { type: "text", text: raw.delta.text };
						} else if (raw.delta?.type === "input_json_delta" && raw.delta.partial_json && typeof raw.index === "number") {
							sawToolCalls = true;
							yield {
								type: "tool_call_delta",
								index: raw.index,
								arguments: raw.delta.partial_json,
							};
						}
						break;
					}
					case "message_delta": {
						stopReason = raw.delta?.stop_reason;
						outputTokens = raw.usage?.output_tokens ?? outputTokens;
						break;
					}
					case "message_stop": {
						const tokenLimit = getProviderModelConfig(config.providerId, options.model, configDir)?.contextWindow ?? 0;
						const display = formatProviderModelDisplay(
							config.providerId,
							options.model,
							inputTokens,
							configDir,
							options.contextLimit,
							options.sessionCostDisplay,
						);
						yield {
							type: "usage",
							tokenCount: inputTokens,
							tokenLimit,
							display,
						};
						options.onMetrics?.({
							model: options.model,
							promptTokens: inputTokens,
							outputTokens,
							promptChars,
							totalTokens: inputTokens + outputTokens,
						});
						yield { type: "finish", reason: stopReason === "tool_use" ? "tool_calls" : "stop" };
						didEmitFinish = true;
						break;
					}
				}
			}

			if (!didEmitFinish) {
				// Stream ended without proper message_stop event
				if (!hasReceivedContent && !sawToolCalls) {
					throw new ProviderError(
						0,
						"Stream ended unexpectedly without receiving any content. This may be due to a network interruption.",
					);
				}
				yield { type: "finish", reason: stopReason === "tool_use" ? "tool_calls" : "stop" };
			}
		},
	};
}
