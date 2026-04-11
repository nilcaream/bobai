import { useCallback, useEffect, useRef, useState } from "react";
import { createEventRouter } from "./eventRouter";
import { formatTimestamp } from "./format";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { useSubagentPeek } from "./hooks/useSubagentPeek";
import { appendPart, appendText } from "./messageBuilder";
import type { Message, MessagePart, ProjectInfo, ServerMessage, StagedSkill, SubagentInfo } from "./protocol";
import { buildSessionUrl } from "./urlUtils";

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
	const [welcomeMarkdown, setWelcomeMarkdown] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);
	const eventRouter = useRef(createEventRouter());
	const messagesRef = useRef<Message[]>([]);
	const autoScrollRef = useRef(true);

	// Keep refs in sync with state
	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);

	const {
		viewingSubagentId,
		viewingSubagentTitle,
		viewingSubagentIdRef,
		parentMessagesRef,
		parentStatusRef,
		setViewingSubagentId,
		setViewingSubagentTitle,
		peekSubagent,
		peekSubagentFromDb,
		exitSubagentPeek,
	} = useSubagentPeek(messagesRef, setMessages, status, setStatus, eventRouter);

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
	}, [fetchProjectInfo, sendSubscribe, viewingSubagentIdRef, parentMessagesRef, parentStatusRef]);

	// Warn user before navigating away during active generation
	useEffect(() => {
		if (!isStreaming) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [isStreaming]);

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
		[isStreaming, fetchProjectInfo, exitSubagentPeek, viewingSubagentIdRef],
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
	}, [sendUnsubscribe, viewingSubagentIdRef, setViewingSubagentId, setViewingSubagentTitle, parentMessagesRef]);

	const { loadSession } = useSessionLoader({
		sessionId,
		sendSubscribe,
		setMessages,
		setTitle,
		setModel,
		setParentId,
		setParentTitle,
		setSubagents,
		setStatus,
		setVolatileMessage,
		setSessionLocked,
		setWelcomeMarkdown,
		viewingSubagentIdRef,
		setViewingSubagentId,
		setViewingSubagentTitle,
		parentMessagesRef,
		eventRouter,
		autoScrollRef,
	});

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
		autoScrollRef,
		peekSubagent,
		peekSubagentFromDb,
		exitSubagentPeek,
	};
}
