import { useCallback, useEffect, useRef, useState } from "react";
import type { createEventRouter } from "../eventRouter";
import { reconstructMessages, type StoredMessage } from "../messageReconstruction";
import type { Message } from "../protocol";
import { replayBufferToMessages } from "../replayBuffer";

export function useSubagentPeek(
	messagesRef: React.MutableRefObject<Message[]>,
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
	status: string,
	setStatus: React.Dispatch<React.SetStateAction<string>>,
	eventRouter: React.MutableRefObject<ReturnType<typeof createEventRouter>>,
) {
	const [viewingSubagentId, setViewingSubagentId] = useState<string | null>(null);
	const [viewingSubagentTitle, setViewingSubagentTitle] = useState<string | null>(null);
	const viewingSubagentIdRef = useRef<string | null>(null);
	const parentMessagesRef = useRef<Message[]>([]);
	const parentStatusRef = useRef("");

	// Keep ref in sync with state
	useEffect(() => {
		viewingSubagentIdRef.current = viewingSubagentId;
	}, [viewingSubagentId]);

	const exitSubagentPeek = useCallback(() => {
		if (!viewingSubagentIdRef.current) return;
		setViewingSubagentId(null);
		setViewingSubagentTitle(null);
		setMessages(parentMessagesRef.current);
		setStatus(parentStatusRef.current);
		parentMessagesRef.current = [];
		parentStatusRef.current = "";
	}, [setMessages, setStatus]);

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
		[status, messagesRef, eventRouter, setMessages, setStatus],
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
		[status, messagesRef, setMessages, setStatus],
	);

	return {
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
	};
}
