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
	return iso
		.replace("T", " ")
		.replace(/\.\d+Z$/, "")
		.replace("Z", "");
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
			const parts: MessagePart[] = [];
			const toolCalls = msg.metadata?.tool_calls as
				| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
				| undefined;

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					parts.push({
						type: "tool_call",
						id: tc.id,
						content: `**${tc.function.name}** ${tc.function.arguments}`,
					});
				}
			}

			if (msg.content) {
				parts.push({ type: "text", content: msg.content });
			}

			currentAssistant = {
				role: "assistant",
				parts,
				timestamp: formatStoredTimestamp(msg.createdAt),
			};
			messages.push(currentAssistant);
			continue;
		}

		if (msg.role === "tool") {
			const toolCallId = msg.metadata?.tool_call_id as string | undefined;
			if (currentAssistant && toolCallId) {
				currentAssistant.parts.push({
					type: "tool_result",
					id: toolCallId,
					content: msg.content,
					mergeable: true,
				});
			}
		}
	}

	return messages;
}
