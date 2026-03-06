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

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					newParts.push({
						type: "tool_call",
						id: tc.id,
						content: `**${tc.function.name}** ${tc.function.arguments}`,
					});
				}
			}

			if (msg.content) {
				newParts.push({ type: "text", content: msg.content });
			}

			const summary = msg.metadata?.summary as string | undefined;
			const model = msg.metadata?.turn_model as string | undefined;

			if (currentAssistant) {
				// Same turn: merge parts into existing assistant message
				currentAssistant.parts.push(...newParts);
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
				const uiOutput = msg.metadata?.ui_output as string | null | undefined;
				currentAssistant.parts.push({
					type: "tool_result",
					id: toolCallId,
					content: uiOutput ?? msg.content,
					mergeable: true,
				});
			}
		}
	}

	return messages;
}
