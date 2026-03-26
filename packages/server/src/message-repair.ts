import type { AssistantMessage, Message, ToolMessage } from "./provider/provider";

interface RepairResult {
	messages: Message[];
	repaired: boolean;
}

/**
 * Repairs message ordering issues that can occur when concurrent agent loops
 * write interleaved messages to the same session, or when a loop is aborted
 * mid-tool-execution leaving orphaned tool_use without tool_result.
 *
 * Two repair strategies:
 * 1. Orphaned tool_use: Insert synthetic "[Tool execution was interrupted]" result
 * 2. Interleaved messages: Reorder so tool_results immediately follow their tool_use
 */
export function repairMessageOrdering(messages: Message[]): RepairResult {
	let repaired = false;
	const result: Message[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Only process assistant messages with tool_calls
		if (msg.role !== "assistant" || !("tool_calls" in msg) || !msg.tool_calls) {
			result.push(msg);
			continue;
		}

		result.push(msg);
		const assistantMsg = msg as AssistantMessage;
		const toolCallIds = assistantMsg.tool_calls.map((tc) => tc.id);

		// Collect tool results and non-tool messages from the remainder
		const pendingResults = new Map<string, ToolMessage>();
		const nonToolMessages: Message[] = [];

		// Scan forward to find all tool_results for these tool_call_ids
		let j = i + 1;

		for (; j < messages.length; j++) {
			const candidate = messages[j];

			if (candidate.role === "tool" && "tool_call_id" in candidate) {
				const toolMsg = candidate as ToolMessage;
				if (toolCallIds.includes(toolMsg.tool_call_id)) {
					pendingResults.set(toolMsg.tool_call_id, toolMsg);
					// Stop scanning if we've found all expected tool results
					if (pendingResults.size === toolCallIds.length) {
						j++;
						break;
					}
					continue;
				}
			}

			// If we hit a user message or another assistant with tool_calls, stop scanning
			if (candidate.role === "user") break;
			if (candidate.role === "assistant" && "tool_calls" in candidate && candidate.tool_calls) break;

			// Non-tool message in the gap (e.g. interleaved from concurrent loop)
			nonToolMessages.push(candidate);
		}

		// Check if everything is already in order
		const allFound = toolCallIds.every((id) => pendingResults.has(id));
		const inOrder = allFound && isToolResultsInOrder(messages, i, toolCallIds);

		if (allFound && inOrder && nonToolMessages.length === 0) {
			// Everything is already correct — skip forward past the tool results
			for (const tcId of toolCallIds) {
				i++;
				result.push(pendingResults.get(tcId)!);
			}
			continue;
		}

		// Repair needed
		repaired = true;

		// Emit tool results in tool_call order
		for (const tcId of toolCallIds) {
			const found = pendingResults.get(tcId);
			if (found) {
				result.push(found);
			} else {
				// Orphaned tool_use — insert synthetic result
				result.push({
					role: "tool",
					content: "[Tool execution was interrupted]",
					tool_call_id: tcId,
				});
			}
		}

		// Emit any non-tool messages that were interleaved
		for (const nonTool of nonToolMessages) {
			result.push(nonTool);
		}

		// Skip past all consumed messages
		i = j - 1;
	}

	return { messages: result, repaired };
}

/** Check if tool results for the given tool_call_ids appear in order immediately after assistantIndex */
function isToolResultsInOrder(messages: Message[], assistantIndex: number, toolCallIds: string[]): boolean {
	let pos = assistantIndex + 1;
	for (const tcId of toolCallIds) {
		if (pos >= messages.length) return false;
		const msg = messages[pos];
		if (msg.role !== "tool" || !("tool_call_id" in msg)) return false;
		if ((msg as ToolMessage).tool_call_id !== tcId) return false;
		pos++;
	}
	return true;
}
