import { useCallback, useEffect, useRef, useState } from "react";
import { createEventRouter } from "./eventRouter";
import { formatTimestamp } from "./format";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { useSubagentPeek } from "./hooks/useSubagentPeek";
import type { Message, ProjectInfo, ServerMessage, StagedSkill, SubagentInfo, VolatileMessage } from "./protocol";
import { buildSessionUrl } from "./urlUtils";
import { applyStreamingEvent, applySubagentLifecycle, stampStreamingCompletion } from "./websocketEventState";

const SESSION_LOCKED_MESSAGE = "Session is active in another tab";

export function shouldSubscribeToSession(currentSessionId: string | null, nextSessionId: string): boolean {
	return currentSessionId !== nextSessionId;
}

export function filterVolatileMessagesOnSessionSubscribed(messages: VolatileMessage[]): VolatileMessage[] {
	return messages.filter((message) => message.text !== SESSION_LOCKED_MESSAGE);
}

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);
	const [title, setTitle] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
	const [parentId, setParentId] = useState<string | null>(null);
	const [parentTitle, setParentTitle] = useState<string | null>(null);
	const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
	const [volatileMessages, setVolatileMessages] = useState<VolatileMessage[]>([]);
	const [sessionLocked, setSessionLocked] = useState(false);
	const [welcomeMarkdown, setWelcomeMarkdown] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);
	const dbDisconnected = useRef(false);
	const addVolatileMessage = useCallback((text: string, kind: VolatileMessage["kind"]) => {
		setVolatileMessages((prev) => [...prev, { text, kind }]);
	}, []);
	const clearVolatileMessages = useCallback(() => {
		setVolatileMessages([]);
	}, []);
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
				clearVolatileMessages();
				history.pushState(null, "", buildSessionUrl(msg.sessionId));
				sendSubscribe(msg.sessionId);
				return;
			}

			if (msg.type === "session_locked") {
				setSessionLocked(true);
				addVolatileMessage(SESSION_LOCKED_MESSAGE, "error");
				return;
			}

			if (msg.type === "session_subscribed") {
				setSessionLocked(false);
				setVolatileMessages((prev) => filterVolatileMessagesOnSessionSubscribed(prev));
				return;
			}

			if (msg.type === "db_disconnected") {
				dbDisconnected.current = true;
				addVolatileMessage(
					"Database file was replaced or deleted. Session data can no longer be saved. Restart the server.",
					"error",
				);
				setIsStreaming(false);
				return;
			}

			// Route through event router
			const result = eventRouter.current.route(msg);

			if (result.target === "lifecycle") {
				setSubagents((prev) => applySubagentLifecycle(prev, msg));
				if (msg.type === "subagent_done" && msg.sessionId === viewingSubagentIdRef.current) {
					setMessages((prev) => stampStreamingCompletion(prev, msg, formatTimestamp()));
				}
				return;
			}

			if (result.target === "child") {
				// Already buffered by router.
				// If peeking at this child, also update displayed messages.
				if (result.sessionId === viewingSubagentIdRef.current) {
					if (msg.type === "status") {
						setStatus(msg.text);
					} else {
						setMessages((prev) => applyStreamingEvent(prev, msg, formatTimestamp()));
					}
				}
				return;
			}

			// result.target === "parent" — handle token, tool_call, tool_result, done, error, status, prompt_echo
			const isPeeking = viewingSubagentIdRef.current !== null;

			if (
				msg.type === "token" ||
				msg.type === "tool_call" ||
				msg.type === "tool_result" ||
				msg.type === "error" ||
				msg.type === "prompt_echo"
			) {
				if (isPeeking) {
					parentMessagesRef.current = applyStreamingEvent(parentMessagesRef.current, msg, formatTimestamp());
				} else {
					setMessages((prev) => applyStreamingEvent(prev, msg, formatTimestamp()));
				}
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				if (msg.provider) setProvider(msg.provider);
				setModel(msg.model);
				if (msg.title) setTitle(msg.title);
				setParentId(null);
				setParentTitle(null);
				if (isPeeking) {
					parentMessagesRef.current = stampStreamingCompletion(parentMessagesRef.current, msg, formatTimestamp());
				} else {
					setMessages((prev) => stampStreamingCompletion(prev, msg, formatTimestamp()));
				}
				setIsStreaming(false);
				fetchProjectInfo();
			}

			if (msg.type === "status") {
				if (isPeeking) {
					parentStatusRef.current = msg.text;
				} else {
					setStatus(msg.text);
				}
			}

			if (msg.type === "error") {
				setIsStreaming(false);
			}
		};

		ws.current = socket;
		fetchProjectInfo();
		return () => socket.close();
	}, [
		fetchProjectInfo,
		sendSubscribe,
		viewingSubagentIdRef,
		parentMessagesRef,
		parentStatusRef,
		addVolatileMessage,
		clearVolatileMessages,
	]);

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

			if (dbDisconnected.current) {
				return;
			}

			// Clear peek state and buffers
			if (viewingSubagentIdRef.current) {
				exitSubagentPeek();
			}
			eventRouter.current.clearAllBuffers();
			setSubagents([]);
			clearVolatileMessages();

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
		[isStreaming, fetchProjectInfo, exitSubagentPeek, viewingSubagentIdRef, clearVolatileMessages],
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
		setProvider(null);
		setModel(null);
		setTitle(null);
		setStatus("");
		setSubagents([]);
		setParentId(null);
		setParentTitle(null);
		clearVolatileMessages();
		setSessionLocked(false);
		history.pushState(null, "", "/bobai");
	}, [
		sendUnsubscribe,
		viewingSubagentIdRef,
		setViewingSubagentId,
		setViewingSubagentTitle,
		parentMessagesRef,
		clearVolatileMessages,
	]);

	const { loadSession } = useSessionLoader({
		sessionId,
		sendSubscribe,
		setMessages,
		setTitle,
		setProvider,
		setModel,
		setParentId,
		setParentTitle,
		setSubagents,
		setStatus,
		addVolatileMessage,
		clearVolatileMessages,
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
		provider,
		setProvider,
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
			const shouldSubscribe = shouldSubscribeToSession(sessionId.current, id);
			sessionId.current = id;
			history.replaceState(null, "", buildSessionUrl(id));
			if (shouldSubscribe) {
				sendSubscribe(id);
			}
		},
		volatileMessages,
		addVolatileMessage,
		clearVolatileMessages,
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
