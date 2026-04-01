import type { AssistantMessage, Message } from "../provider/provider";

/**
 * Messages whose user prompt is further than this distance from the end of
 * the conversation array will have their intermediate messages evicted.
 */
export const EVICTION_DISTANCE = 200;

/**
 * Remove intermediate messages from old turns to reduce message count sent to
 * the LLM provider.  Defends against provider timeouts caused by too many
 * messages.
 *
 * System messages are always preserved.  Recent turns (within
 * {@link EVICTION_DISTANCE} of the end) are kept in full.  Older turns are
 * collapsed to (a) the user prompt, (b) any task tool-call pairs, and (c) a
 * final plain-text assistant response, if one exists.
 *
 * Returns the **same array reference** when nothing was evicted.
 */
export function evictOldTurns(messages: Message[]): Message[] {
	// -----------------------------------------------------------------------
	// 1. Separate system messages (always kept) from the rest.
	// -----------------------------------------------------------------------
	interface IndexedMsg {
		idx: number;
		msg: Message;
	}

	const systemEntries: IndexedMsg[] = [];
	const nonSystem: IndexedMsg[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "system") {
			systemEntries.push({ idx: i, msg });
		} else {
			nonSystem.push({ idx: i, msg });
		}
	}

	// -----------------------------------------------------------------------
	// 2. Split non-system messages into turns.
	//    A turn starts at each role:"user" and extends until the next user.
	//    Messages before the first user prompt form a "pre-turn" group.
	// -----------------------------------------------------------------------
	interface Turn {
		entries: IndexedMsg[];
		userIndex: number; // index of the user prompt in the *original* array
	}

	const preTurn: IndexedMsg[] = [];
	const turns: Turn[] = [];

	for (const entry of nonSystem) {
		if (entry.msg.role === "user") {
			turns.push({ entries: [entry], userIndex: entry.idx });
		} else if (turns.length === 0) {
			preTurn.push(entry);
		} else {
			turns[turns.length - 1].entries.push(entry);
		}
	}

	// -----------------------------------------------------------------------
	// 3. Determine which indices to keep.
	// -----------------------------------------------------------------------
	const keepSet = new Set<number>();

	// System messages are always kept.
	for (const e of systemEntries) keepSet.add(e.idx);

	// Pre-turn messages are always kept.
	for (const e of preTurn) keepSet.add(e.idx);

	// Track assistant messages that need tool_calls filtering.
	// Maps original index → set of tool_call IDs to keep.
	const filteredAssistants = new Map<number, Set<string>>();

	let evicted = false;

	for (const turn of turns) {
		const distanceFromEnd = messages.length - 1 - turn.userIndex;

		if (distanceFromEnd <= EVICTION_DISTANCE) {
			// Recent turn — keep everything.
			for (const e of turn.entries) keepSet.add(e.idx);
			continue;
		}

		// Old turn — collapse.
		// (a) Always keep the user prompt.
		keepSet.add(turn.userIndex);

		// (b) Keep task tool-call pairs.
		for (const e of turn.entries) {
			if (e.msg.role !== "assistant") continue;
			const assistant = e.msg as AssistantMessage;
			if (!assistant.tool_calls) continue;

			const taskCalls = assistant.tool_calls.filter((tc) => tc.function.name === "task");
			if (taskCalls.length === 0) continue;

			keepSet.add(e.idx);
			const taskIds = new Set(taskCalls.map((tc) => tc.id));
			filteredAssistants.set(e.idx, taskIds);

			// Keep corresponding tool result messages.
			for (const te of turn.entries) {
				if (te.msg.role === "tool" && taskIds.has((te.msg as { tool_call_id: string }).tool_call_id)) {
					keepSet.add(te.idx);
				}
			}
		}

		// (c) Keep the last message if it's a plain-text assistant response.
		const last = turn.entries[turn.entries.length - 1];
		if (last && last.msg.role === "assistant") {
			const a = last.msg as AssistantMessage;
			if (a.content && !a.tool_calls) {
				keepSet.add(last.idx);
			}
		}

		// Check whether anything was actually dropped.
		for (const e of turn.entries) {
			if (!keepSet.has(e.idx)) {
				evicted = true;
			}
		}
	}

	if (!evicted) return messages;

	// -----------------------------------------------------------------------
	// 4. Build the filtered array in original order.
	// -----------------------------------------------------------------------
	const result: Message[] = [];

	for (let i = 0; i < messages.length; i++) {
		if (!keepSet.has(i)) continue;

		const taskIds = filteredAssistants.get(i);
		if (taskIds) {
			const original = messages[i] as AssistantMessage;
			const filteredCalls = (original.tool_calls ?? []).filter((tc) => taskIds.has(tc.id));
			result.push({
				role: "assistant",
				content: original.content,
				tool_calls: filteredCalls.length > 0 ? filteredCalls : undefined,
			});
		} else {
			result.push(messages[i]);
		}
	}

	return result;
}
