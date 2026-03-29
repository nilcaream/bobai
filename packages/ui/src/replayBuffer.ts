import type { Message, MessagePart } from "./useWebSocket";

type BufferedEvent = { type: string; [key: string]: unknown };

/** Append to the last assistant message's parts, or create a new assistant message. */
function appendPart(msgs: Message[], part: MessagePart): Message[] {
	const last = msgs.at(-1);
	if (last?.role === "assistant") {
		return [...msgs.slice(0, -1), { ...last, parts: [...last.parts, part] }];
	}
	return [...msgs, { role: "assistant", parts: [part] }];
}

/** Append text to the last text part of the last assistant message, or create one. */
function appendText(msgs: Message[], text: string): Message[] {
	const last = msgs.at(-1);
	if (last?.role === "assistant" && last.parts.length > 0) {
		const lastPart = last.parts.at(-1);
		if (lastPart?.type === "text") {
			const updatedParts = [...last.parts.slice(0, -1), { type: "text" as const, content: lastPart.content + text }];
			return [...msgs.slice(0, -1), { ...last, parts: updatedParts }];
		}
		return appendPart(msgs, { type: "text", content: text });
	}
	return [...msgs, { role: "assistant", parts: [{ type: "text", content: text }] }];
}

/**
 * Replay an array of buffered WebSocket events into a Message[] array.
 * Mirrors the streaming path (appendText/appendPart) but operates on a batch.
 * Non-message events (status, error, done, etc.) are skipped.
 */
export function replayBufferToMessages(events: BufferedEvent[]): Message[] {
	let messages: Message[] = [];
	for (const event of events) {
		if (event.type === "token") {
			messages = appendText(messages, event.text as string);
		} else if (event.type === "tool_call") {
			messages = appendPart(messages, { type: "tool_call", id: event.id as string, content: event.output as string });
		} else if (event.type === "tool_result") {
			messages = appendPart(messages, {
				type: "tool_result",
				id: event.id as string,
				content: event.output as string,
				mergeable: event.mergeable as boolean,
				summary: event.summary as string | undefined,
			});
		}
		// All other event types (status, error, done, etc.) are not message-producing — skip
	}
	return messages;
}
