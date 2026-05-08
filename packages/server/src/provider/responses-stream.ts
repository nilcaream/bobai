import { formatProviderModelDisplay, getProviderModelConfig } from "./models";
import type { ResponsesItemReasoningState, StreamEvent } from "./provider";

export interface ResponsesStreamOptions {
	providerId?: string;
	tokenLimit?: number;
	display?: string;
	contextLimit?: number | null;
	onCompletedUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
}

function getOutputIndex(parsed: Record<string, unknown>, fallback: number): number {
	return typeof parsed.output_index === "number" ? parsed.output_index : fallback;
}

function summarizeReasoningItem(item: Record<string, unknown>): ResponsesItemReasoningState {
	const summaryItems = Array.isArray(item.summary) ? item.summary : [];
	const summary = summaryItems
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "summary_text") {
				return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : undefined;
			}
			return undefined;
		})
		.filter((text): text is string => typeof text === "string" && text.length > 0)
		.join("\n\n");

	return {
		kind: "responses-item",
		...(typeof item.id === "string" ? { id: item.id } : {}),
		...(summary.length > 0 ? { summary } : {}),
		...(typeof item.encrypted_content === "string" ? { encryptedContent: item.encrypted_content } : {}),
	};
}

export async function* parseResponsesSSE(
	stream: ReadableStream<Uint8Array>,
	model: string,
	configDir: string,
	options: ResponsesStreamOptions = {},
): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let toolCallIndex = 0;
	let reasoningIndex = 0;
	let hasToolCalls = false;
	let hasReceivedContent = false;
	const outputIndexToToolIndex = new Map<number, number>();
	const outputIndexToReasoningIndex = new Map<number, number>();

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			let eventData: string | undefined;
			for (const line of part.split("\n")) {
				if (line.startsWith("data: ")) {
					eventData = line.slice("data: ".length);
				}
			}
			if (!eventData) continue;

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(eventData);
			} catch {
				continue;
			}

			const type = parsed.type as string;

			if (type === "response.output_item.added") {
				const item = parsed.item as Record<string, unknown>;
				if (item?.type === "function_call") {
					const idx = getOutputIndex(parsed, toolCallIndex);
					outputIndexToToolIndex.set(idx, toolCallIndex);
					hasToolCalls = true;
					yield {
						type: "tool_call_start",
						index: toolCallIndex,
						id: item.call_id as string,
						name: item.name as string,
					};
					toolCallIndex++;
				} else if (item?.type === "reasoning") {
					const idx = getOutputIndex(parsed, reasoningIndex);
					outputIndexToReasoningIndex.set(idx, reasoningIndex);
					yield {
						type: "reasoning_start",
						index: reasoningIndex,
						reasoning: summarizeReasoningItem(item),
					};
					reasoningIndex++;
				}
			} else if (type === "response.output_text.delta") {
				const delta = parsed.delta as string;
				if (delta) {
					hasReceivedContent = true;
					yield { type: "text", text: delta };
				}
			} else if (type === "response.function_call_arguments.delta") {
				const delta = parsed.delta as string;
				if (delta) {
					const outputIdx = getOutputIndex(parsed, 0);
					const mappedIdx = outputIndexToToolIndex.get(outputIdx);
					if (mappedIdx === undefined) continue;
					yield {
						type: "tool_call_delta",
						index: mappedIdx,
						arguments: delta,
					};
				}
			} else if (type === "response.reasoning_summary_text.delta") {
				const delta = parsed.delta as string;
				if (delta) {
					const outputIdx = getOutputIndex(parsed, 0);
					const mappedIdx = outputIndexToReasoningIndex.get(outputIdx);
					if (mappedIdx === undefined) continue;
					yield {
						type: "reasoning_delta",
						index: mappedIdx,
						delta: { kind: "summary", summary: delta },
					};
				}
			} else if (type === "response.output_item.done") {
				const item = parsed.item as Record<string, unknown>;
				if (item?.type === "reasoning") {
					const outputIdx = getOutputIndex(parsed, 0);
					const mappedIdx = outputIndexToReasoningIndex.get(outputIdx);
					if (mappedIdx === undefined) continue;
					yield {
						type: "reasoning_end",
						index: mappedIdx,
						reasoning: summarizeReasoningItem(item),
					};
					outputIndexToReasoningIndex.delete(outputIdx);
				}
			} else if (type === "response.completed") {
				const response = parsed.response as Record<string, unknown> | undefined;
				const usage = response?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							total_tokens?: number;
					  }
					| undefined;
				const inputTokens = usage?.input_tokens ?? 0;
				const outputTokens = usage?.output_tokens ?? 0;
				const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
				options.onCompletedUsage?.({ inputTokens, outputTokens, totalTokens });

				const providerId = options.providerId ?? "github-copilot";
				const contextWindow =
					options.tokenLimit ?? getProviderModelConfig(providerId as never, model, configDir)?.contextWindow ?? 0;
				const display =
					options.display ??
					formatProviderModelDisplay(providerId as never, model, inputTokens, configDir, options.contextLimit);

				yield {
					type: "usage",
					tokenCount: inputTokens,
					tokenLimit: contextWindow,
					display,
					outputTokens,
					totalTokens,
				};
				yield {
					type: "finish",
					reason: hasToolCalls ? "tool_calls" : "stop",
				};
				return;
			} else if (type === "response.failed") {
				const response = parsed.response as Record<string, unknown> | undefined;
				const error = response?.error as { code?: string; message?: string } | undefined;
				const details = response?.incomplete_details as { reason?: string } | undefined;
				const msg = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: "Unknown error";
				throw new Error(msg);
			} else if (type === "error") {
				const code = parsed.code as string | undefined;
				const message = parsed.message as string | undefined;
				throw new Error(`${code || "error"}: ${message || "Unknown error"}`);
			}
		}
	}

	// Stream ended without response.completed
	if (!hasReceivedContent && !hasToolCalls) {
		throw new Error("Stream ended unexpectedly without receiving any content. This may be due to a network interruption.");
	}
	yield { type: "finish", reason: hasToolCalls ? "tool_calls" : "stop" };
}
