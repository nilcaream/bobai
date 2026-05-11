import { formatStoredTimestamp } from "./format";
import type { Message, MessagePart } from "./protocol";

export interface StoredMessage {
	id: string;
	sessionId: string;
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	createdAt: string;
	sortOrder: number;
	metadata: Record<string, unknown> | null;
}

/** Escape characters that have special meaning in Markdown so they render as literal text. */
function escapeMarkdown(text: string): string {
	return text.replace(/([*_`~\\[\]|#>])/g, "\\$1");
}

/** Extract text from a Qwen-style reasoning_details array. */
function extractReasoningTextFromDetails(details: unknown): string | undefined {
	if (Array.isArray(details)) {
		const parts: string[] = [];
		for (const item of details) {
			if (
				item &&
				typeof item === "object" &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string"
			) {
				parts.push(item.text);
			}
		}
		return parts.length > 0 ? parts.join("") : undefined;
	}
	return undefined;
}

export function reconstructMessages(stored: StoredMessage[]): Message[] {
	const messages: Message[] = [];
	let currentAssistant: (Message & { role: "assistant" }) | null = null;

	for (const msg of stored) {
		if (msg.role === "system") continue;

		if (msg.role === "user") {
			currentAssistant = null;
			messages.push({
				role: "user",
				text: msg.content,
				timestamp: formatStoredTimestamp(msg.createdAt),
			});
			continue;
		}

		if (msg.role === "assistant") {
			const newParts: MessagePart[] = [];
			const toolCalls = msg.metadata?.tool_calls as
				| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
				| undefined;
			const hasVisibleContent = msg.content.trim().length > 0;

			// Reasoning before text — matches streaming order where reasoning
			// blocks are emitted before text tokens.
			const reasoning = msg.metadata?.reasoning as
				| Array<{ kind: string; text?: string; summary?: string; details?: unknown }>
				| undefined;
			if (reasoning && reasoning.length > 0) {
				for (const r of reasoning) {
					let reasoningText = r.text ?? r.summary ?? "";
					if (!reasoningText && r.details) {
						reasoningText = extractReasoningTextFromDetails(r.details) ?? "";
					}
					if (reasoningText) {
						newParts.push({ type: "reasoning", content: reasoningText });
					}
				}
			}

			// Text before tool_calls — matches streaming order where the provider
			// emits text tokens first, then fires tool_call events.
			if (hasVisibleContent) {
				newParts.push({ type: "text", content: msg.content });
			}

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					newParts.push({
						type: "tool_call",
						id: tc.id,
						content: `**${tc.function.name}** ${escapeMarkdown(tc.function.arguments)}`,
					});
				}
			}

			const summary = msg.metadata?.summary as string | undefined;
			const model = msg.metadata?.turn_model as string | undefined;

			if (currentAssistant) {
				// Same turn: merge parts into existing assistant message
				currentAssistant.parts.push(...newParts);
				currentAssistant.timestamp = formatStoredTimestamp(msg.createdAt);
				if (summary) currentAssistant.summary = summary;
				if (model) currentAssistant.model = model;
			} else {
				// New turn: create a new assistant message
				currentAssistant = {
					role: "assistant",
					parts: newParts,
					timestamp: formatStoredTimestamp(msg.createdAt),
					...(summary ? { summary } : {}),
					...(model ? { model } : {}),
				};
				messages.push(currentAssistant);
			}
			continue;
		}

		if (msg.role === "tool") {
			const toolCallId = msg.metadata?.tool_call_id as string | undefined;
			if (currentAssistant && toolCallId) {
				// Fix tool_call part content with the formatted call output if available
				const formatCall = msg.metadata?.format_call as string | undefined;
				if (formatCall) {
					const callPart = currentAssistant.parts.find((p) => p.type === "tool_call" && p.id === toolCallId);
					if (callPart) callPart.content = formatCall;
				}

				const hasUiOutput = msg.metadata != null && "ui_output" in msg.metadata;
				const content = hasUiOutput ? (msg.metadata?.ui_output as string | null) : msg.content;
				const mergeable = msg.metadata?.mergeable !== undefined ? (msg.metadata.mergeable as boolean) : true;
				const summary = msg.metadata?.tool_summary as string | undefined;
				const subagentSessionId = msg.metadata?.subagent_session_id as string | undefined;
				currentAssistant.parts.push({
					type: "tool_result",
					id: toolCallId,
					content,
					mergeable,
					...(summary ? { summary } : {}),
					...(subagentSessionId ? { subagentSessionId } : {}),
				});
			}
		}
	}

	return messages;
}
