import type { Message, MessagePart } from "./useWebSocket";

export interface StoredMessage {
	id: string;
	sessionId: string;
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	createdAt: string;
	sortOrder: number;
	metadata: Record<string, unknown> | null;
}

function formatStoredTimestamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

			// Text before tool_calls — matches streaming order where the provider
			// emits text tokens first, then fires tool_call events.
			if (msg.content) {
				newParts.push({ type: "text", content: msg.content });
			}

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					newParts.push({
						type: "tool_call",
						id: tc.id,
						content: `**${tc.function.name}** ${tc.function.arguments}`,
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
				const content = hasUiOutput ? (msg.metadata!.ui_output as string | null) : msg.content;
				const mergeable = msg.metadata?.mergeable !== undefined ? (msg.metadata.mergeable as boolean) : true;
				const summary = msg.metadata?.tool_summary as string | undefined;
				currentAssistant.parts.push({
					type: "tool_result",
					id: toolCallId,
					content,
					mergeable,
					...(summary ? { summary } : {}),
				});
			}
		}
	}

	return messages;
}
