import { formatModelDisplay, loadModelsConfig } from "./copilot-models";
import type { StreamEvent } from "./provider";

export async function* parseResponsesSSE(
	stream: ReadableStream<Uint8Array>,
	model: string,
	_initiator: "user" | "agent",
	configDir: string,
): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let toolCallIndex = 0;
	let hasToolCalls = false;
	const outputIndexToToolIndex = new Map<number, number>();

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
					const idx = typeof parsed.output_index === "number" ? parsed.output_index : toolCallIndex;
					outputIndexToToolIndex.set(idx, toolCallIndex);
					hasToolCalls = true;
					yield {
						type: "tool_call_start",
						index: toolCallIndex,
						id: item.call_id as string,
						name: item.name as string,
					};
					toolCallIndex++;
				}
			} else if (type === "response.output_text.delta") {
				const delta = parsed.delta as string;
				if (delta) {
					yield { type: "text", text: delta };
				}
			} else if (type === "response.function_call_arguments.delta") {
				const delta = parsed.delta as string;
				if (delta) {
					const outputIdx = typeof parsed.output_index === "number" ? parsed.output_index : 0;
					const mappedIdx = outputIndexToToolIndex.get(outputIdx) ?? 0;
					yield {
						type: "tool_call_delta",
						index: mappedIdx,
						arguments: delta,
					};
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

				const configs = loadModelsConfig(configDir);
				const contextWindow = configs.find((m) => m.id === model)?.contextWindow ?? 0;
				const display = formatModelDisplay(model, inputTokens, configDir);

				yield {
					type: "usage",
					tokenCount: inputTokens,
					tokenLimit: contextWindow,
					display,
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
	yield { type: "finish", reason: hasToolCalls ? "tool_calls" : "stop" };
}
