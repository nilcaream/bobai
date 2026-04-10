import { useCallback } from "react";
import type { createEventRouter } from "../eventRouter";
import { reconstructMessages, type StoredMessage } from "../messageReconstruction";
import type { Message, SubagentInfo } from "../protocol";
import { buildSessionUrl } from "../urlUtils";

interface UseSessionLoaderOptions {
	sessionId: React.MutableRefObject<string | null>;
	sendSubscribe: (sid: string) => void;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setTitle: React.Dispatch<React.SetStateAction<string | null>>;
	setModel: React.Dispatch<React.SetStateAction<string | null>>;
	setParentId: React.Dispatch<React.SetStateAction<string | null>>;
	setParentTitle: React.Dispatch<React.SetStateAction<string | null>>;
	setSubagents: React.Dispatch<React.SetStateAction<SubagentInfo[]>>;
	setStatus: React.Dispatch<React.SetStateAction<string>>;
	setVolatileMessage: React.Dispatch<React.SetStateAction<{ text: string; kind: "error" | "success" } | null>>;
	setSessionLocked: React.Dispatch<React.SetStateAction<boolean>>;
	setWelcomeMarkdown: React.Dispatch<React.SetStateAction<string | null>>;
	viewingSubagentIdRef: React.MutableRefObject<string | null>;
	setViewingSubagentId: React.Dispatch<React.SetStateAction<string | null>>;
	setViewingSubagentTitle: React.Dispatch<React.SetStateAction<string | null>>;
	parentMessagesRef: React.MutableRefObject<Message[]>;
	eventRouter: React.MutableRefObject<ReturnType<typeof createEventRouter>>;
}

export function useSessionLoader({
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
}: UseSessionLoaderOptions) {
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
		// All deps are stable refs or React state setters — safe empty array
		[
			sendSubscribe,
			sessionId,
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
		],
	);

	return { loadSession };
}
