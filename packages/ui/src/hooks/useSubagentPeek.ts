import { useCallback, useEffect, useRef, useState } from "react";
import type { createEventRouter } from "../eventRouter";
import type { StoredMessage } from "../messageReconstruction";
import type { Message } from "../protocol";
import { buildDbPeekState, buildExitPeekState, buildLivePeekState } from "../subagentPeekState";

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
		const nextState = buildExitPeekState({
			storedParentMessages: parentMessagesRef.current,
			storedParentStatus: parentStatusRef.current,
		});
		setViewingSubagentId(nextState.viewingSubagentId);
		setViewingSubagentTitle(nextState.viewingSubagentTitle);
		setMessages(nextState.displayedMessages);
		setStatus(nextState.displayedStatus);
		parentMessagesRef.current = nextState.storedParentMessages;
		parentStatusRef.current = nextState.storedParentStatus;
	}, [setMessages, setStatus]);

	const peekSubagent = useCallback(
		(childSessionId: string) => {
			if (viewingSubagentIdRef.current === childSessionId) return;
			const nextState = buildLivePeekState({
				childSessionId,
				currentMessages: messagesRef.current,
				currentStatus: status,
				storedParentMessages: parentMessagesRef.current,
				storedParentStatus: parentStatusRef.current,
				bufferedEvents: eventRouter.current.getBuffer(childSessionId),
			});
			setViewingSubagentId(nextState.viewingSubagentId);
			setViewingSubagentTitle(nextState.viewingSubagentTitle); // live peeks fall back to subagents array lookup
			setMessages(nextState.displayedMessages);
			setStatus(nextState.displayedStatus);
			parentMessagesRef.current = nextState.storedParentMessages;
			parentStatusRef.current = nextState.storedParentStatus;
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
				const nextState = buildDbPeekState({
					childSessionId,
					currentMessages: messagesRef.current,
					currentStatus: status,
					storedParentMessages: parentMessagesRef.current,
					storedParentStatus: parentStatusRef.current,
					data,
				});
				setViewingSubagentId(nextState.viewingSubagentId);
				setViewingSubagentTitle(nextState.viewingSubagentTitle);
				setMessages(nextState.displayedMessages);
				setStatus(nextState.displayedStatus);
				parentMessagesRef.current = nextState.storedParentMessages;
				parentStatusRef.current = nextState.storedParentStatus;
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
