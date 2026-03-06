import { useCallback, useEffect, useRef, useState } from "react";
import { reconstructMessages, type StoredMessage } from "./messageReconstruction";

type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; summary?: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "subagent_start"; sessionId: string; title: string }
	| { type: "subagent_done"; sessionId: string };

export type SubagentInfo = {
	sessionId: string;
	title: string;
	status: "running" | "done";
};

export type MessagePart =
	| { type: "text"; content: string }
	| { type: "tool_call"; id: string; content: string }
	| { type: "tool_result"; id: string; content: string | null; mergeable: boolean; summary?: string };

export type Message =
	| { role: "user"; text: string; timestamp: string }
	| { role: "assistant"; parts: MessagePart[]; timestamp?: string; model?: string; summary?: string };

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
	const [title, setTitle] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
	const [parentId, setParentId] = useState<string | null>(null);
	const [parentTitle, setParentTitle] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			if (msg.type === "subagent_start") {
				setSubagents((prev) => [...prev, { sessionId: msg.sessionId, title: msg.title, status: "running" }]);
				return;
			}

			if (msg.type === "subagent_done") {
				setSubagents((prev) => prev.map((s) => (s.sessionId === msg.sessionId ? { ...s, status: "done" } : s)));
				return;
			}

			// Skip events tagged with a child sessionId (don't render in parent chat)
			if ("sessionId" in msg && msg.type !== "done" && msg.sessionId) return;

			if (msg.type === "token") {
				setMessages((prev) => appendText(prev, msg.text));
			}

			if (msg.type === "tool_call") {
				setMessages((prev) => appendPart(prev, { type: "tool_call", id: msg.id, content: msg.output }));
			}

			if (msg.type === "tool_result") {
				setMessages((prev) =>
					appendPart(prev, {
						type: "tool_result",
						id: msg.id,
						content: msg.output,
						mergeable: msg.mergeable,
						summary: msg.summary,
					}),
				);
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				setModel(msg.model);
				if (msg.title) setTitle(msg.title);
				setParentId(null);
				setParentTitle(null);
				setMessages((prev) => {
					const last = prev.at(-1);
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { ...last, timestamp: formatTimestamp(), model: msg.model, summary: msg.summary }];
					}
					return prev;
				});
				setIsStreaming(false);
			}

			if (msg.type === "error") {
				setMessages((prev) => appendPart(prev, { type: "text", content: `Error: ${msg.message}` }));
				setIsStreaming(false);
			}

			if (msg.type === "status") {
				setStatus(msg.text);
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
		setTitle(null);
		setStatus("");
		setSubagents([]);
		setParentId(null);
		setParentTitle(null);
	}, []);

	const addErrorMessage = useCallback((text: string) => {
		setMessages((prev) => appendPart(prev, { type: "text", content: `Error: ${text}` }));
	}, []);

	const loadSession = useCallback(async (targetId: string) => {
		try {
			const res = await fetch(`/bobai/session/${targetId}/load`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				session: { id: string; title: string | null; model: string | null; parentId: string | null };
				messages: StoredMessage[];
				status: string | null;
			};
			sessionId.current = data.session.id;
			setTitle(data.session.title);
			setModel(data.session.model);
			setParentId(data.session.parentId);
			setSubagents([]);
			setStatus(data.status ?? "");
			setMessages(reconstructMessages(data.messages));

			// Fetch parent title for subagent status bar
			if (data.session.parentId) {
				const parentRes = await fetch(`/bobai/session/${data.session.parentId}/load`);
				if (parentRes.ok) {
					const parentData = await parentRes.json();
					setParentTitle(parentData.session.title);
				}
			} else {
				setParentTitle(null);
			}
		} catch {
			// Session load failed — leave UI in current state
		}
	}, []);

	return {
		messages,
		connected,
		isStreaming,
		sendPrompt,
		newChat,
		model,
		setModel,
		title,
		setTitle,
		status,
		setStatus,
		subagents,
		addErrorMessage,
		parentId,
		parentTitle,
		loadSession,
		getSessionId: () => sessionId.current,
		setSessionId: (id: string) => {
			sessionId.current = id;
		},
	};
}
