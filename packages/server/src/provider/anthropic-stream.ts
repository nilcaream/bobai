import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { StreamEvent } from "./provider";

/**
 * Convert an Anthropic SDK message stream (async iterable of SSE events)
 * into BobAI's StreamEvent union.
 */
export async function* parseAnthropicStream(
	// biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK SSE events are untyped
	stream: AsyncIterable<any>,
	model: string,
	configDir: string,
	contextLimit?: number | null,
	sessionCostDisplay?: string,
): AsyncGenerator<StreamEvent> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let stopReason: string | undefined;
	let didEmitFinish = false;

	for await (const event of stream) {
		switch (event.type) {
			case "message_start": {
				inputTokens = event.message?.usage?.input_tokens ?? 0;
				cachedInputTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
				cacheCreationInputTokens = event.message?.usage?.cache_creation_input_tokens ?? 0;
				break;
			}

			case "content_block_start": {
				const block = event.content_block;
				if (block?.type === "tool_use") {
					yield {
						type: "tool_call_start",
						index: event.index,
						id: block.id,
						name: block.name,
					};
				}
				// text blocks and thinking blocks: nothing to emit at start
				break;
			}

			case "content_block_delta": {
				const delta = event.delta;
				if (delta?.type === "text_delta") {
					yield { type: "text", text: delta.text };
				} else if (delta?.type === "input_json_delta") {
					yield {
						type: "tool_call_delta",
						index: event.index,
						arguments: delta.partial_json,
					};
				}
				// thinking_delta and other delta types: ignored
				break;
			}

			case "content_block_stop": {
				// Nothing to emit
				break;
			}

			case "message_delta": {
				stopReason = event.delta?.stop_reason;
				outputTokens = event.usage?.output_tokens ?? outputTokens;
				break;
			}

			case "message_stop": {
				// Emit usage event
				const tokenLimit = getProviderModelConfig("github-copilot", model, configDir)?.contextWindow ?? 0;
				const display = formatProviderModelDisplay(
					"github-copilot",
					model,
					inputTokens,
					configDir,
					contextLimit,
					sessionCostDisplay,
				);
				const totalTokens = inputTokens + outputTokens;

				yield {
					type: "usage",
					tokenCount: inputTokens,
					tokenLimit,
					display,
					outputTokens,
					totalTokens,
					cachedInputTokens,
					cacheCreationInputTokens,
				};

				// Emit finish event
				yield {
					type: "finish",
					reason: mapStopReason(stopReason),
				};
				didEmitFinish = true;
				break;
			}
		}
	}

	// If the stream ended without message_stop, emit finish anyway
	if (!didEmitFinish) {
		yield {
			type: "finish",
			reason: mapStopReason(stopReason),
		};
	}
}

function mapStopReason(reason: string | undefined): "stop" | "tool_calls" {
	return reason === "tool_use" ? "tool_calls" : "stop";
}
