import { appendPart, appendReasoning, appendText, startReasoning } from "./messageBuilder";
import type { Message, MessagePart, ServerMessage, SubagentInfo } from "./protocol";

function isStreamingMessage(msg: ServerMessage): msg is Extract<
	ServerMessage,
	{
		type:
			| "prompt_echo"
			| "token"
			| "reasoning_start"
			| "reasoning_token"
			| "reasoning_end"
			| "tool_call"
			| "tool_result"
			| "error";
	}
> {
	return (
		msg.type === "prompt_echo" ||
		msg.type === "token" ||
		msg.type === "reasoning_start" ||
		msg.type === "reasoning_token" ||
		msg.type === "reasoning_end" ||
		msg.type === "tool_call" ||
		msg.type === "tool_result" ||
		msg.type === "error"
	);
}

export function applyStreamingEvent(messages: Message[], msg: ServerMessage, now: string): Message[] {
	if (!isStreamingMessage(msg)) {
		return messages;
	}

	if (msg.type === "prompt_echo") {
		return [...messages, { role: "user", text: msg.text, timestamp: now }];
	}

	if (msg.type === "token") {
		return appendText(messages, msg.text);
	}

	if (msg.type === "reasoning_start") {
		return startReasoning(messages);
	}

	if (msg.type === "reasoning_token") {
		return appendReasoning(messages, msg.text);
	}

	if (msg.type === "reasoning_end") {
		return messages;
	}

	if (msg.type === "tool_call") {
		const part: MessagePart = { type: "tool_call", id: msg.id, content: msg.output };
		return appendPart(messages, part);
	}

	if (msg.type === "tool_result") {
		const part: MessagePart = {
			type: "tool_result",
			id: msg.id,
			content: msg.output,
			mergeable: msg.mergeable,
			summary: msg.summary,
		};
		return appendPart(messages, part);
	}

	return appendPart(messages, { type: "text", content: `Error: ${msg.message}` });
}

export function stampStreamingCompletion(
	messages: Message[],
	msg: Extract<ServerMessage, { type: "done" } | { type: "subagent_done" }>,
	now: string,
): Message[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") {
		return messages;
	}

	return [
		...messages.slice(0, -1),
		{ ...last, timestamp: now, model: msg.model, ...(msg.summary ? { summary: msg.summary } : {}) },
	];
}

export function applySubagentLifecycle(subagents: SubagentInfo[], msg: ServerMessage): SubagentInfo[] {
	if (msg.type === "subagent_start") {
		return [...subagents, { sessionId: msg.sessionId, title: msg.title, status: "running", toolCallId: msg.toolCallId }];
	}

	if (msg.type === "subagent_done") {
		return subagents.map((s) => (s.sessionId === msg.sessionId ? { ...s, status: "done" } : s));
	}

	return subagents;
}
