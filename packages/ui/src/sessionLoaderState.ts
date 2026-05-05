import { reconstructMessages, type StoredMessage } from "./messageReconstruction";
import type { Message, SubagentInfo, VolatileMessage } from "./protocol";

interface LoadedSessionData {
	session: { id: string; title: string | null; provider: string | null; model: string | null; parentId: string | null };
	messages: StoredMessage[];
	status: string | null;
}

interface LoadedSessionState {
	sessionId: string;
	title: string | null;
	provider: string | null;
	model: string | null;
	parentId: string | null;
	subagents: SubagentInfo[];
	status: string;
	messages: Message[];
}

interface LockedSessionState {
	sessionId: string;
	sessionLocked: true;
	messages: Message[];
	volatileMessage: VolatileMessage;
}

export function createLockedSessionState(sessionId: string): LockedSessionState {
	return {
		sessionId,
		sessionLocked: true,
		messages: [],
		volatileMessage: { text: "Session is active in another tab", kind: "error" },
	};
}

export function applyLoadedSessionState(data: LoadedSessionData): LoadedSessionState {
	return {
		sessionId: data.session.id,
		title: data.session.title,
		provider: data.session.provider,
		model: data.session.model,
		parentId: data.session.parentId,
		subagents: [],
		status: data.status ?? "",
		messages: reconstructMessages(data.messages),
	};
}
