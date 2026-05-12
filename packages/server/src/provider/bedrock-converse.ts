import type { AmazonBedrockAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { appendCachePoint, convertMessagesToConverse, convertToolsToConverse } from "./bedrock-converse-convert";
import { parseBedrockEventStream } from "./bedrock-event-stream";
import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";

function bedrockRuntimeUrl(region: string, modelId: string): string {
	return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse-stream`;
}

export function createBedrockConverseProvider(
	auth: AmazonBedrockAuth,
	_logger?: Logger,
	fetchFn: typeof fetch = fetch,
	configDir = "",
): Provider {
	return {
		id: "amazon-bedrock",
		configDir,
		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const { messages, system } = convertMessagesToConverse(options.messages);
			const tools = options.tools?.length ? convertToolsToConverse(options.tools) : undefined;
			const maxTokens = options.maxOutputTokens;

			// Add cache point to enable prompt caching for this request.
			// The cachePoint marks the end of the cacheable prefix (tools → system → messages
			// up to this point). On subsequent requests with the same prefix, cached content
			// is reused automatically, reducing cost and latency.
			appendCachePoint(messages);

			const url = bedrockRuntimeUrl(auth.region, options.model);

			const body: Record<string, unknown> = {
				messages,
				inferenceConfig: { maxTokens },
				...(system ? { system } : {}),
				...(tools ? { toolConfig: tools } : {}),
			};

			const response = await fetchFn(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${auth.apiKey}`,
					Accept: "application/vnd.amazon.eventstream",
					...(options.sessionId ? { "x-session-affinity": options.sessionId.substring(0, 8) } : {}),
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}
			if (!response.body) {
				yield { type: "finish", reason: "stop" };
				return;
			}

			// Converse stream event order:
			//   messageStart → contentBlock* → messageStop → metadata
			// We collect stopReason from messageStop and emit finish after metadata.

			const promptChars = options.messages.reduce((sum, m) => {
				let s = sum;
				if (typeof m.content === "string") s += m.content.length;
				if ("reasoning" in m && Array.isArray(m.reasoning)) {
					for (const r of m.reasoning) {
						if (r.text) s += r.text.length;
						if (r.summary) s += r.summary.length;
					}
				}
				return s;
			}, 0);

			let stopReason: string | undefined;
			let didEmitFinish = false;
			let hasReceivedContent = false;

			// Track active content block types so tool_call_delta knows the right index
			const blockTypes = new Map<number, "text" | "toolUse">();
			const thinkingBlockIndices = new Set<number>();

			for await (const event of parseBedrockEventStream(response.body)) {
				const { eventType, payload } = event;
				const raw = payload as Record<string, unknown>;

				switch (eventType) {
					case "contentBlockStart": {
						const index = raw.contentBlockIndex as number;
						const start = raw.start as Record<string, unknown> | undefined;

						if (start?.toolUse) {
							const toolUse = start.toolUse as { toolUseId: string; name: string };
							blockTypes.set(index, "toolUse");
							yield {
								type: "tool_call_start",
								index,
								id: toolUse.toolUseId,
								name: toolUse.name,
							};
						} else if (start?.reasoningContent) {
							thinkingBlockIndices.add(index);
							yield {
								type: "reasoning_start",
								index,
								reasoning: { kind: "text-summary", text: "" },
							};
						} else {
							blockTypes.set(index, "text");
						}
						break;
					}

					case "contentBlockDelta": {
						const index = raw.contentBlockIndex as number;
						const delta = raw.delta as Record<string, unknown> | undefined;

						if (delta?.text) {
							hasReceivedContent = true;
							yield { type: "text", text: delta.text as string };
						} else if (delta?.toolUse) {
							const toolUseDelta = delta.toolUse as { input: string };
							yield {
								type: "tool_call_delta",
								index,
								arguments: toolUseDelta.input,
							};
						} else if (delta?.reasoningContent) {
							const reasoningDelta = delta.reasoningContent as { text?: string };
							if (reasoningDelta.text) {
								yield {
									type: "reasoning_delta",
									index,
									delta: { kind: "text", text: reasoningDelta.text },
								};
							}
						}
						break;
					}

					case "contentBlockStop": {
						const index = raw.contentBlockIndex as number;
						if (thinkingBlockIndices.has(index)) {
							thinkingBlockIndices.delete(index);
							yield {
								type: "reasoning_end",
								index,
							};
						}
						break;
					}

					case "messageStop": {
						stopReason = raw.stopReason as string | undefined;
						break;
					}

					case "metadata": {
						const usage = raw.usage as
							| {
									inputTokens?: number;
									outputTokens?: number;
									cacheReadInputTokens?: number;
									cacheWriteInputTokens?: number;
							  }
							| undefined;
						const inputTokens = usage?.inputTokens ?? 0;
						const outputTokens = usage?.outputTokens ?? 0;
						const cachedInputTokens = usage?.cacheReadInputTokens ?? 0;
						const cacheCreationInputTokens = usage?.cacheWriteInputTokens ?? 0;

						const tokenLimit = getProviderModelConfig("amazon-bedrock", options.model, configDir)?.contextWindow ?? 0;
						const display = formatProviderModelDisplay(
							"amazon-bedrock",
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
							outputTokens,
							totalTokens: inputTokens + outputTokens,
							cachedInputTokens,
							cacheCreationInputTokens,
						};

						options.onMetrics?.({
							model: options.model,
							promptTokens: inputTokens,
							outputTokens,
							promptChars,
							totalTokens: inputTokens + outputTokens,
							cachedInputTokens,
							cacheCreationInputTokens,
						});

						yield {
							type: "finish",
							reason: stopReason === "tool_use" ? "tool_calls" : "stop",
						};
						didEmitFinish = true;
						break;
					}

					// messageStart — no action needed
					default:
						break;
				}
			}

			if (!didEmitFinish) {
				// Stream ended without proper metadata event
				if (!hasReceivedContent) {
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
