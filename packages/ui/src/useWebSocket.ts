import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };

export type Message = { role: "user" | "assistant"; text: string };

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const sessionId = useRef<string | null>(null);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			if (msg.type === "token") {
				setMessages((prev) => {
					const last = prev.at(-1);
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
					}
					return [...prev, { role: "assistant", text: msg.text }];
				});
			}

			if (msg.type === "tool_call") {
				setMessages((prev) => {
					const last = prev.at(-1);
					const status = `\n[Calling ${msg.name}...]\n`;
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { role: "assistant", text: last.text + status }];
					}
					return [...prev, { role: "assistant", text: status }];
				});
			}

			if (msg.type === "tool_result") {
				setMessages((prev) => {
					const last = prev.at(-1);
					const status = msg.isError ? `[${msg.name} failed]\n` : `[${msg.name} done]\n`;
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { role: "assistant", text: last.text + status }];
					}
					return [...prev, { role: "assistant", text: status }];
				});
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				setIsStreaming(false);
			}

			if (msg.type === "error") {
				setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${msg.message}` }]);
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
			setMessages((prev) => [...prev, { role: "user", text }]);
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
	}, []);

	return { messages, connected, isStreaming, sendPrompt, newChat };
}
