import { useCallback, useEffect, useRef, useState } from "react";

// Server → Client messages
type ServerMessage =
	| { type: "token"; text: string }
	| { type: "done" }
	| { type: "error"; message: string };

export type Message = { role: "user" | "assistant"; text: string };

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);

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

			if (msg.type === "error") {
				setMessages((prev) => [
					...prev,
					{ role: "assistant", text: `Error: ${msg.message}` },
				]);
			}
		};

		ws.current = socket;
		return () => socket.close();
	}, []);

	const sendPrompt = useCallback((text: string) => {
		if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
		setMessages((prev) => [...prev, { role: "user", text }]);
		ws.current.send(JSON.stringify({ type: "prompt", text }));
	}, []);

	return { messages, connected, sendPrompt };
}
