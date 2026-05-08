import type { AmazonBedrockAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { convertMessagesToConverse, convertToolsToConverse } from "./bedrock-converse-convert";
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
			const maxTokens = getProviderModelConfig("amazon-bedrock", options.model, configDir)?.maxOutput ?? 16384;

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
				if (typeof m.content === "string") return sum + m.content.length;
				return sum;
			}, 0);

			let stopReason: string | undefined;
			let didEmitFinish = false;

			// Track active content block types so tool_call_delta knows the right index
			const blockTypes = new Map<number, "text" | "toolUse">();

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
						} else {
							blockTypes.set(index, "text");
						}
						break;
					}

					case "contentBlockDelta": {
						const index = raw.contentBlockIndex as number;
						const delta = raw.delta as Record<string, unknown> | undefined;

						if (delta?.text) {
							yield { type: "text", text: delta.text as string };
						} else if (delta?.toolUse) {
							const toolUseDelta = delta.toolUse as { input: string };
							yield {
								type: "tool_call_delta",
								index,
								arguments: toolUseDelta.input,
							};
						}
						break;
					}

					case "contentBlockStop": {
						// Nothing to emit — tool_call_end is not a thing in our StreamEvent type
						break;
					}

					case "messageStop": {
						stopReason = raw.stopReason as string | undefined;
						break;
					}

					case "metadata": {
						const usage = raw.usage as { inputTokens?: number; outputTokens?: number } | undefined;
						const inputTokens = usage?.inputTokens ?? 0;
						const outputTokens = usage?.outputTokens ?? 0;

						const tokenLimit = getProviderModelConfig("amazon-bedrock", options.model, configDir)?.contextWindow ?? 0;
						const display = formatProviderModelDisplay(
							"amazon-bedrock",
							options.model,
							inputTokens,
							configDir,
							options.contextLimit,
						);

						yield {
							type: "usage",
							tokenCount: inputTokens,
							tokenLimit,
							display,
							outputTokens,
							totalTokens: inputTokens + outputTokens,
						};

						options.onMetrics?.({
							model: options.model,
							promptTokens: inputTokens,
							outputTokens,
							promptChars,
							totalTokens: inputTokens + outputTokens,
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
				yield { type: "finish", reason: stopReason === "tool_use" ? "tool_calls" : "stop" };
			}
		},
	};
}
