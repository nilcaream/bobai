import type { Logger } from "../log/logger";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type {
	AssistantMessage,
	InterleavedChatReasoningField,
	Message,
	Provider,
	ProviderOptions,
	ReasoningState,
	StreamEvent,
} from "./provider";
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

export interface OpenAIChatCompatibleProviderOptions {
	providerId: ProviderId;
	baseUrl: string;
	apiKey: string;
}

type OpenAIChatMessage = Message | (AssistantMessage & Partial<Record<InterleavedChatReasoningField, unknown>>);

function getInterleavedReasoningValue(
	reasoning: ReasoningState[] | undefined,
	field: InterleavedChatReasoningField,
): string | unknown | undefined {
	for (const item of reasoning ?? []) {
		if (item.kind !== "interleaved-chat" || item.field !== field) continue;
		if (field === "reasoning_details") return item.details;
		return item.text;
	}
	return undefined;
}

function appendReasoningText(
	current: ReasoningState | undefined,
	field: InterleavedChatReasoningField,
	text: string,
): ReasoningState {
	if (current?.kind === "interleaved-chat" && current.field === field) {
		return { ...current, text: (current.text ?? "") + text };
	}
	return { kind: "interleaved-chat", field, text };
}

function setReasoningDetails(
	current: ReasoningState | undefined,
	field: InterleavedChatReasoningField,
	details: unknown,
): ReasoningState {
	if (current?.kind === "interleaved-chat" && current.field === field) {
		return { ...current, details };
	}
	return { kind: "interleaved-chat", field, details };
}

function shouldReplayInterleavedReasoning(
	capabilities: ReasoningCapabilities | undefined,
): capabilities is ReasoningCapabilities & {
	family: "openai-chat-interleaved";
	assistantField: InterleavedChatReasoningField;
} {
	return (
		capabilities?.family === "openai-chat-interleaved" &&
		capabilities.supportsReplay &&
		capabilities.assistantField !== undefined
	);
}

export function convertMessagesToOpenAIChat(messages: Message[], capabilities?: ReasoningCapabilities): OpenAIChatMessage[] {
	return messages
		.filter((message) => {
			// Filter out assistant messages with empty content and no tool_calls
			// These can occur from interrupted sessions and cause provider errors
			if (message.role === "assistant") {
				const hasContent = message.content && message.content.trim().length > 0;
				const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
				return hasContent || hasToolCalls;
			}
			return true;
		})
		.map((message) => {
			if (message.role !== "assistant") return { ...message };
			const { reasoning: _reasoning, ...assistantMessage } = message;
			if (!shouldReplayInterleavedReasoning(capabilities)) {
				return assistantMessage;
			}

			const value = getInterleavedReasoningValue(message.reasoning, capabilities.assistantField);
			const shouldIncludeField =
				value !== undefined || (capabilities.requiresEmptyAssistantReasoningFields === true && message.reasoning !== undefined);
			if (!shouldIncludeField) return assistantMessage;

			return {
				...assistantMessage,
				[capabilities.assistantField]: value ?? "",
			};
		});
}

export function createOpenAIChatCompatibleProvider(
	config: OpenAIChatCompatibleProviderOptions,
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
				apiFamily: "openai-chat-completions",
			});
			const requestMessages = convertMessagesToOpenAIChat(options.messages, reasoningCapabilities);
			const response = await fetchFn(config.baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
					...(options.sessionId
						? {
								[config.providerId.startsWith("opencode") ? "x-opencode-session" : "x-session-affinity"]:
									options.sessionId.substring(0, 8),
							}
						: {}),
				},
				body: JSON.stringify({
					model: options.model,
					messages: requestMessages,
					max_tokens: options.maxOutputTokens,
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
			let sawAnyToolCalls = false;
			let hasReceivedContent = false;
			const reasoningField = shouldReplayInterleavedReasoning(reasoningCapabilities)
				? reasoningCapabilities.assistantField
				: undefined;
			let activeReasoning: ReasoningState | undefined;
			let reasoningStarted = false;

			for await (const event of parseSSE(response.body)) {
				const data = event as {
					choices?: {
						delta?: {
							content?: string;
							reasoning?: string;
							reasoning_content?: string;
							reasoning_details?: unknown;
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

				if (reasoningField) {
					if (delta?.reasoning_content != null && reasoningField === "reasoning_content") {
						activeReasoning = appendReasoningText(activeReasoning, reasoningField, delta.reasoning_content);
					} else if (delta?.reasoning != null && reasoningField === "reasoning") {
						activeReasoning = appendReasoningText(activeReasoning, reasoningField, delta.reasoning);
					} else if (delta?.reasoning_details != null && reasoningField === "reasoning_details") {
						activeReasoning = setReasoningDetails(activeReasoning, reasoningField, delta.reasoning_details);
					}
					if (activeReasoning && !reasoningStarted) {
						yield { type: "reasoning_start", index: 0, reasoning: { kind: "interleaved-chat", field: reasoningField } };
						reasoningStarted = true;
					}
					if (delta?.reasoning_content != null && reasoningField === "reasoning_content") {
						yield { type: "reasoning_delta", index: 0, delta: { kind: "text", text: delta.reasoning_content } };
					}
					if (delta?.reasoning != null && reasoningField === "reasoning") {
						yield { type: "reasoning_delta", index: 0, delta: { kind: "text", text: delta.reasoning } };
					}
					if (delta?.reasoning_details != null && reasoningField === "reasoning_details") {
						yield { type: "reasoning_delta", index: 0, delta: { kind: "details", details: delta.reasoning_details } };
					}
				}

				if (delta?.content) {
					hasReceivedContent = true;
					yield { type: "text", text: delta.content };
				}

				for (const toolCall of delta?.tool_calls ?? []) {
					sawAnyToolCalls = true;
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
					finishReason = choice.finish_reason === "tool_calls" || sawAnyToolCalls ? "tool_calls" : "stop";
					const tokenLimit = getProviderModelConfig(config.providerId, options.model, configDir)?.contextWindow ?? 0;
					const display = formatProviderModelDisplay(
						config.providerId,
						options.model,
						promptTokens,
						configDir,
						options.contextLimit,
						options.sessionCostDisplay,
					);
					if (reasoningStarted) {
						yield { type: "reasoning_end", index: 0, reasoning: activeReasoning };
						reasoningStarted = false;
					}
					yield { type: "usage", tokenCount: promptTokens, tokenLimit, display };
					options.onMetrics?.({
						model: options.model,
						promptTokens,
						outputTokens: Math.max(0, totalTokens - promptTokens),
						promptChars,
						totalTokens,
					});
					yield { type: "finish", reason: finishReason };
					sawFinish = true;
				}
			}

			if (!sawFinish) {
				// Stream ended without a proper finish_reason - this indicates a network
				// interruption or incomplete response from the server
				if (!hasReceivedContent && !sawAnyToolCalls && !reasoningStarted) {
					throw new ProviderError(
						0,
						"Stream ended unexpectedly without receiving any content. This may be due to a network interruption.",
					);
				}
				if (reasoningStarted) {
					yield { type: "reasoning_end", index: 0, reasoning: activeReasoning };
				}
				yield { type: "finish", reason: finishReason };
			}
		},
	};
}
