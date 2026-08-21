import type { Logger } from "../log/logger";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type {
	AssistantMessage,
	InterleavedChatReasoningField,
	InterleavedChatReasoningState,
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

export interface OpenAIChatCompatibleProviderOptions {
	providerId: ProviderId;
	baseUrl: string;
	apiKey: string;
}

type OpenAIChatMessage = Message | (AssistantMessage & Partial<Record<InterleavedChatReasoningField, unknown>>);

export function appendReasoningText(
	current: ReasoningState | undefined,
	field: InterleavedChatReasoningField,
	text: string,
): ReasoningState {
	if (current?.kind === "interleaved-chat" && current.field === field) {
		return { ...current, text: (current.text ?? "") + text };
	}
	return { kind: "interleaved-chat", field, text };
}

export function setReasoningDetails(
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
): capabilities is ReasoningCapabilities & { family: "openai-chat-interleaved" } {
	return capabilities?.family === "openai-chat-interleaved" && capabilities.supportsReplay;
}

export function convertMessagesToOpenAIChat(messages: Message[], capabilities?: ReasoningCapabilities): OpenAIChatMessage[] {
	// Pre-scan: find the reasoning field name from any assistant message that has
	// interleaved-chat reasoning. Used as a fallback for messages without reasoning
	// when the provider requires empty reasoning fields.
	const knownField = messages
		.flatMap((m) => (m.role === "assistant" ? (m.reasoning ?? []) : []))
		.find((e): e is InterleavedChatReasoningState => e.kind === "interleaved-chat")?.field;

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

			// Derive the field name from this message's own reasoning, or fall back
			// to the first known field from any message in the conversation.
			const chatEntries = (message.reasoning ?? []).filter(
				(e): e is InterleavedChatReasoningState => e.kind === "interleaved-chat",
			);
			const field = chatEntries[0]?.field ?? knownField;

			if (!field) return assistantMessage;

			const value = field === "reasoning_details" ? chatEntries[0]?.details : chatEntries[0]?.text;

			const shouldIncludeField =
				value !== undefined || (capabilities.requiresEmptyAssistantReasoningFields === true && message.reasoning !== undefined);
			if (!shouldIncludeField) return assistantMessage;

			return {
				...assistantMessage,
				[field]: value ?? "",
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
			const modelConfig = getProviderModelConfig(config.providerId, options.model, configDir);
			const response = await fetchFn(config.baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "BobAI/1.0",
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
					...(config.providerId === "openrouter" && modelConfig?.supportsCaching && options.sessionId
						? { prompt_cache_key: options.sessionId }
						: {}),
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
			let cachedTokens: number | undefined;
			let cacheWriteTokens: number | undefined;
			let finishReason: "stop" | "tool_calls" = "stop";
			let sawFinish = false;
			let sawAnyToolCalls = false;
			let hasReceivedContent = false;
			const canReason = reasoningCapabilities.family === "openai-chat-interleaved" && reasoningCapabilities.supportsReplay;
			let reasoningField: InterleavedChatReasoningField | undefined;
			let activeReasoning: ReasoningState | undefined;
			let reasoningStarted = false;

			for await (const event of parseSSE(response.body)) {
				const data = event as {
					choices?: {
						delta?: {
							content?: string;
							reasoning?: string | null;
							reasoning_content?: string | null;
							reasoning_text?: string | null;
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
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
						prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
					};
				};

				// Accumulate usage from every chunk, not just the finish_reason chunk.
				// Some providers (e.g. OpenCode Zen GLM-5.2) send prompt_tokens_details
				// in a trailing chunk with no choices, after the finish_reason chunk.
				if (data.usage?.prompt_tokens != null) {
					promptTokens = data.usage.prompt_tokens;
				}
				if (data.usage?.total_tokens != null) {
					totalTokens = data.usage.total_tokens;
				}
				if (data.usage?.prompt_tokens_details?.cached_tokens != null) {
					cachedTokens = data.usage.prompt_tokens_details.cached_tokens;
				}
				if (data.usage?.prompt_tokens_details?.cache_write_tokens != null) {
					cacheWriteTokens = data.usage.prompt_tokens_details.cache_write_tokens;
				}

				const choice = data.choices?.[0];
				const delta = choice?.delta;

				// ── Reasoning auto-detection ──────────────────────────
				// Check all known reasoning fields unconditionally. The field name is
				// auto-detected from the first chunk that carries reasoning data and
				// locked in for the remainder of the stream.
				if (canReason) {
					const rc = delta?.reasoning_content;
					const r = delta?.reasoning;
					const rt = delta?.reasoning_text;
					const rd = delta?.reasoning_details;

					// Detect field on first reasoning chunk.
					if (!reasoningField) {
						if (rc != null) reasoningField = "reasoning_content";
						else if (r != null) reasoningField = "reasoning";
						else if (rt != null) reasoningField = "reasoning_text";
						else if (rd != null) reasoningField = "reasoning_details";
					}

					if (reasoningField) {
						if (rd != null) {
							activeReasoning = setReasoningDetails(activeReasoning, reasoningField, rd);
						} else {
							const text = rc ?? r ?? rt;
							if (text != null) {
								activeReasoning = appendReasoningText(activeReasoning, reasoningField, text);
							}
						}

						if (activeReasoning && !reasoningStarted) {
							yield {
								type: "reasoning_start",
								index: 0,
								reasoning: { kind: "interleaved-chat", field: reasoningField },
							};
							reasoningStarted = true;
						}

						if (rd != null) {
							yield { type: "reasoning_delta", index: 0, delta: { kind: "details", details: rd } };
						} else {
							const text = rc ?? r ?? rt;
							if (text != null) {
								yield { type: "reasoning_delta", index: 0, delta: { kind: "text", text } };
							}
						}
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
					if (choice.finish_reason === "error") {
						// Model emitted a stream-level error (e.g. MALFORMED_FUNCTION_CALL).
						// Preserve what was already accumulated — reasoning + content still has value.
						// Skip the zeroed-out usage to avoid misleading status bar numbers.
						if (reasoningStarted) {
							yield { type: "reasoning_end", index: 0, reasoning: activeReasoning as ReasoningState };
							reasoningStarted = false;
						}
						yield { type: "finish", reason: "stop" };
						return;
					}
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
					yield {
						type: "usage",
						tokenCount: promptTokens,
						tokenLimit,
						display,
						cachedInputTokens: cachedTokens,
						cacheCreationInputTokens: cacheWriteTokens,
					};
					yield { type: "finish", reason: finishReason };
					sawFinish = true;
				}
			}

			// Call onMetrics after consuming all chunks so that cache tokens sent in
			// trailing chunks (after the finish_reason chunk) are included.
			options.onMetrics?.({
				model: options.model,
				promptTokens,
				outputTokens: Math.max(0, totalTokens - promptTokens),
				promptChars,
				totalTokens,
				cachedInputTokens: cachedTokens,
				cacheCreationInputTokens: cacheWriteTokens,
			});

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
