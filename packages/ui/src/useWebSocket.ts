import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
	| { type: "done"; sessionId: string; model: string }
	| { type: "error"; message: string };

export type MessagePart =
	| { type: "text"; content: string }
	| { type: "tool_call"; name: string; content: string }
	| { type: "tool_result"; name: string; content: string; isError: boolean };

export type Message =
	| { role: "user"; text: string; timestamp: string }
	| { role: "assistant"; parts: MessagePart[]; timestamp?: string };

function formatTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Append to the last assistant message's parts, or create a new assistant message. */
function appendPart(prev: Message[], part: MessagePart): Message[] {
	const last = prev.at(-1);
	if (last?.role === "assistant") {
		const updated: Message = { ...last, parts: [...last.parts, part] };
		return [...prev.slice(0, -1), updated];
	}
	return [...prev, { role: "assistant", parts: [part] }];
}

/** Append text to the last text part of the last assistant message, or create one. */
function appendText(prev: Message[], text: string): Message[] {
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

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [model, setModel] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			if (msg.type === "token") {
				setMessages((prev) => appendText(prev, msg.text));
			}

			if (msg.type === "tool_call") {
				let content: string;
				if (msg.name === "bash" && typeof msg.arguments.command === "string") {
					content = `$ ${msg.arguments.command}`;
				} else if (msg.name === "read_file" && typeof msg.arguments.path === "string") {
					content = `▸ Reading ${msg.arguments.path}`;
				} else {
					content = `[${msg.name}]`;
				}
				setMessages((prev) => appendPart(prev, { type: "tool_call", name: msg.name, content }));
			}

			if (msg.type === "tool_result") {
				setMessages((prev) =>
					appendPart(prev, { type: "tool_result", name: msg.name, content: msg.output, isError: msg.isError ?? false }),
				);
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				setModel(msg.model);
				setMessages((prev) => {
					const last = prev.at(-1);
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { ...last, timestamp: formatTimestamp() }];
					}
					return prev;
				});
				setIsStreaming(false);
			}

			if (msg.type === "error") {
				setMessages((prev) => appendPart(prev, { type: "text", content: `Error: ${msg.message}` }));
				setIsStreaming(false);
			}
		};

		ws.current = socket;
		return () => socket.close();
	}, []);

	const sendPrompt = useCallback(
		(text: string) => {
			if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
			if (isStreaming) return;
			setIsStreaming(true);
			setMessages((prev) => [...prev, { role: "user", text, timestamp: formatTimestamp() }]);
			const payload: { type: string; text: string; sessionId?: string } = { type: "prompt", text };
			if (sessionId.current) {
				payload.sessionId = sessionId.current;
			}
			ws.current.send(JSON.stringify(payload));
		},
		[isStreaming],
	);

	const newChat = useCallback(() => {
		sessionId.current = null;
		setMessages([]);
		setModel(null);
	}, []);

	return { messages, connected, isStreaming, sendPrompt, newChat, model };
}
