import { appendPart, appendText } from "./messageBuilder";
import type { Message } from "./protocol";

type BufferedEvent = { type: string; [key: string]: unknown };

/**
 * Replay an array of buffered WebSocket events into a Message[] array.
 * Mirrors the streaming path (appendText/appendPart) but operates on a batch.
 * Non-message events (status, error, done, etc.) are skipped.
 */
export function replayBufferToMessages(events: BufferedEvent[]): Message[] {
	let messages: Message[] = [];
	for (const event of events) {
		if (event.type === "prompt_echo") {
			messages = [...messages, { role: "user", text: event.text as string, timestamp: "" }];
		} else if (event.type === "token") {
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
