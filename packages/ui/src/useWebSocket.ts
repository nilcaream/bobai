import { useCallback, useEffect, useRef, useState } from "react";
import { createEventRouter } from "./eventRouter";
import { reconstructMessages, type StoredMessage } from "./messageReconstruction";
import { replayBufferToMessages } from "./replayBuffer";
import { buildSessionUrl } from "./urlUtils";

type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; summary?: string; sessionId?: string }
	| { type: "prompt_echo"; text: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "session_created"; sessionId: string }
	| { type: "session_subscribed"; sessionId: string }
	| { type: "session_locked"; sessionId: string }
	| { type: "subagent_start"; sessionId: string; title: string; toolCallId: string }
	| { type: "subagent_done"; sessionId: string };

type SubagentInfo = {
	sessionId: string;
	title: string;
	status: "running" | "done";
	toolCallId: string;
};

type ProjectInfo = {
	dir: string;
	git?: { branch: string; revision: string };
};

export type StagedSkill = { name: string; content: string };

export type MessagePart =
	| { type: "text"; content: string }
	| { type: "tool_call"; id: string; content: string }
	| {
			type: "tool_result";
			id: string;
			content: string | null;
			mergeable: boolean;
			summary?: string;
			subagentSessionId?: string;
	  };

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
	const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
	const [volatileMessage, setVolatileMessage] = useState<{ text: string; kind: "error" | "success" } | null>(null);
	const [sessionLocked, setSessionLocked] = useState(false);
	const [viewingSubagentId, setViewingSubagentId] = useState<string | null>(null);
	const [viewingSubagentTitle, setViewingSubagentTitle] = useState<string | null>(null);
	const [welcomeMarkdown, setWelcomeMarkdown] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);
	const eventRouter = useRef(createEventRouter());
	const viewingSubagentIdRef = useRef<string | null>(null);
	const parentMessagesRef = useRef<Message[]>([]);
	const parentStatusRef = useRef("");
	const messagesRef = useRef<Message[]>([]);

	// Keep refs in sync with state
	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);
	useEffect(() => {
		viewingSubagentIdRef.current = viewingSubagentId;
	}, [viewingSubagentId]);

	const fetchProjectInfo = useCallback(() => {
		fetch("/bobai/project-info")
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (data) setProjectInfo(data);
			})
			.catch(() => {});
	}, []);

	const sendSubscribe = useCallback((sid: string) => {
		if (ws.current && ws.current.readyState === WebSocket.OPEN) {
			ws.current.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
		}
	}, []);

	const sendUnsubscribe = useCallback(() => {
		if (ws.current && ws.current.readyState === WebSocket.OPEN) {
			ws.current.send(JSON.stringify({ type: "unsubscribe" }));
		}
	}, []);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			// Session-level concerns — handle before the event router
			if (msg.type === "session_created") {
				sessionId.current = msg.sessionId;
				setVolatileMessage(null);
				history.pushState(null, "", buildSessionUrl(msg.sessionId));
				sendSubscribe(msg.sessionId);
				return;
			}

			if (msg.type === "session_locked") {
				setSessionLocked(true);
				setVolatileMessage({ text: "Session is active in another tab", kind: "error" });
				return;
			}

			if (msg.type === "session_subscribed") {
				setSessionLocked(false);
				setVolatileMessage(null);
				return;
			}

			// Route through event router
			const result = eventRouter.current.route(msg);

			if (result.target === "lifecycle") {
				if (msg.type === "subagent_start") {
					setSubagents((prev) => [
						...prev,
						{ sessionId: msg.sessionId, title: msg.title, status: "running", toolCallId: msg.toolCallId },
					]);
				}
				if (msg.type === "subagent_done") {
					setSubagents((prev) => prev.map((s) => (s.sessionId === msg.sessionId ? { ...s, status: "done" } : s)));
				}
				return;
			}

			if (result.target === "child") {
				// Already buffered by router.
				// If peeking at this child, also update displayed messages.
				if (result.sessionId === viewingSubagentIdRef.current) {
					if (msg.type === "prompt_echo") {
						const userMsg: Message = { role: "user", text: msg.text, timestamp: formatTimestamp() };
						setMessages((prev) => [...prev, userMsg]);
					} else if (msg.type === "token") {
						setMessages((prev) => appendText(prev, msg.text));
					} else if (msg.type === "tool_call") {
						setMessages((prev) => appendPart(prev, { type: "tool_call", id: msg.id, content: msg.output }));
					} else if (msg.type === "tool_result") {
						setMessages((prev) =>
							appendPart(prev, {
								type: "tool_result",
								id: msg.id,
								content: msg.output,
								mergeable: msg.mergeable,
								summary: msg.summary,
							}),
						);
					} else if (msg.type === "status") {
						setStatus(msg.text);
					}
				}
				return;
			}

			// result.target === "parent" — handle token, tool_call, tool_result, done, error, status, prompt_echo
			const isPeeking = viewingSubagentIdRef.current !== null;

			if (msg.type === "token") {
				if (isPeeking) {
					parentMessagesRef.current = appendText(parentMessagesRef.current, msg.text);
				} else {
					setMessages((prev) => appendText(prev, msg.text));
				}
			}

			if (msg.type === "tool_call") {
				const part: MessagePart = { type: "tool_call", id: msg.id, content: msg.output };
				if (isPeeking) {
					parentMessagesRef.current = appendPart(parentMessagesRef.current, part);
				} else {
					setMessages((prev) => appendPart(prev, part));
				}
			}

			if (msg.type === "tool_result") {
				const part: MessagePart = {
					type: "tool_result",
					id: msg.id,
					content: msg.output,
					mergeable: msg.mergeable,
					summary: msg.summary,
				};
				if (isPeeking) {
					parentMessagesRef.current = appendPart(parentMessagesRef.current, part);
				} else {
					setMessages((prev) => appendPart(prev, part));
				}
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				setModel(msg.model);
				if (msg.title) setTitle(msg.title);
				setParentId(null);
				setParentTitle(null);
				if (isPeeking) {
					const last = parentMessagesRef.current.at(-1);
					if (last?.role === "assistant") {
						parentMessagesRef.current = [
							...parentMessagesRef.current.slice(0, -1),
							{ ...last, timestamp: formatTimestamp(), model: msg.model, summary: msg.summary },
						];
					}
				} else {
					setMessages((prev) => {
						const last = prev.at(-1);
						if (last?.role === "assistant") {
							return [...prev.slice(0, -1), { ...last, timestamp: formatTimestamp(), model: msg.model, summary: msg.summary }];
						}
						return prev;
					});
				}
				setIsStreaming(false);
				fetchProjectInfo();
			}

			if (msg.type === "error") {
				const part: MessagePart = { type: "text", content: `Error: ${msg.message}` };
				if (isPeeking) {
					parentMessagesRef.current = appendPart(parentMessagesRef.current, part);
				} else {
					setMessages((prev) => appendPart(prev, part));
				}
				setIsStreaming(false);
			}

			if (msg.type === "status") {
				if (isPeeking) {
					parentStatusRef.current = msg.text;
				} else {
					setStatus(msg.text);
				}
			}

			if (msg.type === "prompt_echo") {
				const userMsg: Message = { role: "user", text: msg.text, timestamp: formatTimestamp() };
				if (isPeeking) {
					parentMessagesRef.current = [...parentMessagesRef.current, userMsg];
				} else {
					setMessages((prev) => [...prev, userMsg]);
				}
			}
		};

		ws.current = socket;
		fetchProjectInfo();
		return () => socket.close();
	}, [fetchProjectInfo, sendSubscribe]);

	// Warn user before navigating away during active generation
	useEffect(() => {
		if (!isStreaming) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [isStreaming]);

	const exitSubagentPeek = useCallback(() => {
		if (!viewingSubagentIdRef.current) return;
		setViewingSubagentId(null);
		setViewingSubagentTitle(null);
		setMessages(parentMessagesRef.current);
		setStatus(parentStatusRef.current);
		parentMessagesRef.current = [];
		parentStatusRef.current = "";
	}, []);

	const peekSubagent = useCallback(
		(childSessionId: string) => {
			if (viewingSubagentIdRef.current === childSessionId) return;
			if (!viewingSubagentIdRef.current) {
				parentMessagesRef.current = messagesRef.current;
				parentStatusRef.current = status;
			}
			setViewingSubagentId(childSessionId);
			setViewingSubagentTitle(null); // live peeks fall back to subagents array lookup
			const bufferedEvents = eventRouter.current.getBuffer(childSessionId);
			const childMessages = replayBufferToMessages(bufferedEvents);
			setMessages(childMessages);
			const lastStatusEvent = bufferedEvents.findLast((e) => e.type === "status");
			if (lastStatusEvent && "text" in lastStatusEvent) {
				setStatus((lastStatusEvent as { type: "status"; text: string }).text);
			}
		},
		[status],
	);

	const peekSubagentFromDb = useCallback(
		async (childSessionId: string) => {
			if (viewingSubagentIdRef.current === childSessionId) return;
			try {
				const res = await fetch(`/bobai/session/${childSessionId}/load`);
				if (!res.ok) return;
				const data = (await res.json()) as {
					session: { id: string; title: string | null };
					messages: StoredMessage[];
					status: string | null;
				};
				if (!viewingSubagentIdRef.current) {
					parentMessagesRef.current = messagesRef.current;
					parentStatusRef.current = status;
				}
				setViewingSubagentId(childSessionId);
				setViewingSubagentTitle(data.session.title);
				setMessages(reconstructMessages(data.messages));
				if (data.status) {
					setStatus(data.status);
				}
			} catch {
				// fetch failed — ignore
			}
		},
		[status],
	);

	const sendPrompt = useCallback(
		(text: string, stagedSkills?: StagedSkill[]) => {
			if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
			if (isStreaming) return;

			// Clear peek state and buffers
			if (viewingSubagentIdRef.current) {
				exitSubagentPeek();
			}
			eventRouter.current.clearAllBuffers();
			setSubagents([]);
			setVolatileMessage(null);

			setIsStreaming(true);
			// When staged skills are present, the server sends prompt_echo after skill
			// tool panels so the user message appears in the correct visual order.
			// Without staged skills, add the user message immediately for instant feedback.
			const hasSkills = stagedSkills && stagedSkills.length > 0;
			if (!hasSkills) {
				setMessages((prev) => [...prev, { role: "user", text, timestamp: formatTimestamp() }]);
			}
			const payload: { type: string; text: string; sessionId?: string; stagedSkills?: StagedSkill[] } = {
				type: "prompt",
				text,
			};
			if (sessionId.current) {
				payload.sessionId = sessionId.current;
			}
			if (hasSkills) {
				payload.stagedSkills = stagedSkills;
			}
			fetchProjectInfo();
			ws.current.send(JSON.stringify(payload));
		},
		[isStreaming, fetchProjectInfo, exitSubagentPeek],
	);

	const sendCancel = useCallback(() => {
		if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
		if (!isStreaming) return;
		ws.current.send(JSON.stringify({ type: "cancel" }));
	}, [isStreaming]);

	const newChat = useCallback(() => {
		// Clear peek state
		if (viewingSubagentIdRef.current) {
			setViewingSubagentId(null);
			setViewingSubagentTitle(null);
			parentMessagesRef.current = [];
		}
		eventRouter.current.clearAllBuffers();
		sendUnsubscribe();

		sessionId.current = null;
		setMessages([]);
		setModel(null);
		setTitle(null);
		setStatus("");
		setSubagents([]);
		setParentId(null);
		setParentTitle(null);
		setVolatileMessage(null);
		setSessionLocked(false);
		history.pushState(null, "", "/bobai");
	}, [sendUnsubscribe]);

	const loadSession = useCallback(
		async (targetId: string, options?: { skipUrlUpdate?: boolean }): Promise<boolean> => {
			setWelcomeMarkdown(null);
			// Clear peek state
			if (viewingSubagentIdRef.current) {
				setViewingSubagentId(null);
				setViewingSubagentTitle(null);
				parentMessagesRef.current = [];
			}
			eventRouter.current.clearAllBuffers();
			setSessionLocked(false);

			// Check ownership before loading to avoid flicker
			try {
				const ownershipRes = await fetch(`/bobai/session/${targetId}/ownership`);
				if (ownershipRes.ok) {
					const ownershipData = await ownershipRes.json();
					if (ownershipData.owned) {
						// Session is owned by another tab — go straight to locked state
						sessionId.current = targetId;
						setSessionLocked(true);
						setVolatileMessage({ text: "Session is active in another tab", kind: "error" });
						setMessages([]);
						if (!options?.skipUrlUpdate) {
							history.pushState(null, "", buildSessionUrl(targetId));
						}
						sendSubscribe(targetId);
						return true;
					}
				}
			} catch {
				// Ownership check failed — proceed with normal load
			}

			try {
				const res = await fetch(`/bobai/session/${targetId}/load`);
				if (!res.ok) return false;
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
				setVolatileMessage(null);

				if (!options?.skipUrlUpdate) {
					history.pushState(null, "", buildSessionUrl(data.session.id));
				}

				sendSubscribe(data.session.id);

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
				return true;
			} catch {
				return false;
			}
		},
		[sendSubscribe],
	);

	return {
		messages,
		connected,
		isStreaming,
		sendPrompt,
		sendCancel,
		newChat,
		model,
		setModel,
		title,
		setTitle,
		status,
		setStatus,
		subagents,
		parentId,
		parentTitle,
		projectInfo,
		loadSession,
		getSessionId: () => sessionId.current,
		setSessionId: (id: string) => {
			sessionId.current = id;
			history.replaceState(null, "", buildSessionUrl(id));
			sendSubscribe(id);
		},
		volatileMessage,
		setVolatileMessage,
		sessionLocked,
		viewingSubagentId,
		viewingSubagentTitle,
		welcomeMarkdown,
		setWelcomeMarkdown,
		peekSubagent,
		peekSubagentFromDb,
		exitSubagentPeek,
	};
}
