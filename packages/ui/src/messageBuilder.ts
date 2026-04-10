import type { Message, MessagePart } from "./protocol";

/** Append to the last assistant message's parts, or create a new assistant message. */
export function appendPart(prev: Message[], part: MessagePart): Message[] {
	const last = prev.at(-1);
	if (last?.role === "assistant") {
		const updated: Message = { ...last, parts: [...last.parts, part] };
		return [...prev.slice(0, -1), updated];
	}
	return [...prev, { role: "assistant", parts: [part] }];
}

/** Append text to the last text part of the last assistant message, or create one. */
export function appendText(prev: Message[], text: string): Message[] {
	const last = prev.at(-1);
	if (last?.role === "assistant" && last.parts.length > 0) {
		const lastPart = last.parts.at(-1);
		if (lastPart?.type === "text") {
			const updatedParts = [...last.parts.slice(0, -1), { type: "text" as const, content: lastPart.content + text }];
			return [...prev.slice(0, -1), { ...last, parts: updatedParts }];
		}
		return appendPart(prev, { type: "text", content: text });
	}
	return [...prev, { role: "assistant", parts: [{ type: "text", content: text }] }];
}
