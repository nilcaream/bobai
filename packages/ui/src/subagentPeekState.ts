import { reconstructMessages, type StoredMessage } from "./messageReconstruction";
import type { Message, ServerMessage } from "./protocol";
import { replayBufferToMessages } from "./replayBuffer";

interface LivePeekInput {
	childSessionId: string;
	currentMessages: Message[];
	currentStatus: string;
	storedParentMessages: Message[];
	storedParentStatus: string;
	bufferedEvents: ServerMessage[];
}

interface DbPeekInput {
	childSessionId: string;
	currentMessages: Message[];
	currentStatus: string;
	storedParentMessages: Message[];
	storedParentStatus: string;
	data: {
		session: { id: string; title: string | null };
		messages: StoredMessage[];
		status: string | null;
	};
}

interface PeekStateResult {
	viewingSubagentId: string | null;
	viewingSubagentTitle: string | null;
	displayedMessages: Message[];
	displayedStatus: string;
	storedParentMessages: Message[];
	storedParentStatus: string;
}

interface ExitPeekInput {
	storedParentMessages: Message[];
	storedParentStatus: string;
}

function preserveOrCaptureParentSnapshot(
	currentMessages: Message[],
	currentStatus: string,
	storedParentMessages: Message[],
	storedParentStatus: string,
): Pick<PeekStateResult, "storedParentMessages" | "storedParentStatus"> {
	if (storedParentMessages.length > 0) {
		return {
			storedParentMessages,
			storedParentStatus,
		};
	}

	return {
		storedParentMessages: currentMessages,
		storedParentStatus: currentStatus,
	};
}

export function buildLivePeekState(input: LivePeekInput): PeekStateResult {
	const parentSnapshot = preserveOrCaptureParentSnapshot(
		input.currentMessages,
		input.currentStatus,
		input.storedParentMessages,
		input.storedParentStatus,
	);
	const displayedMessages = replayBufferToMessages(input.bufferedEvents);
	const lastStatusEvent = input.bufferedEvents.findLast((event) => event.type === "status");
	const displayedStatus =
		lastStatusEvent && "text" in lastStatusEvent
			? (lastStatusEvent as { type: "status"; text: string }).text
			: input.currentStatus;

	return {
		viewingSubagentId: input.childSessionId,
		viewingSubagentTitle: null,
		displayedMessages,
		displayedStatus,
		...parentSnapshot,
	};
}

export function buildDbPeekState(input: DbPeekInput): PeekStateResult {
	const parentSnapshot = preserveOrCaptureParentSnapshot(
		input.currentMessages,
		input.currentStatus,
		input.storedParentMessages,
		input.storedParentStatus,
	);

	return {
		viewingSubagentId: input.childSessionId,
		viewingSubagentTitle: input.data.session.title,
		displayedMessages: reconstructMessages(input.data.messages),
		displayedStatus: input.data.status ?? input.currentStatus,
		...parentSnapshot,
	};
}

export function buildExitPeekState(input: ExitPeekInput): PeekStateResult {
	return {
		viewingSubagentId: null,
		viewingSubagentTitle: null,
		displayedMessages: input.storedParentMessages,
		displayedStatus: input.storedParentStatus,
		storedParentMessages: [],
		storedParentStatus: "",
	};
}
