import type { AssistantMessage, Message } from "../provider/provider";
import { COMPACTION_MARKER } from "./default-strategy";

/**
 * A superseded tool message. The `toolCallId` identifies the tool result message
 * and `reason` describes why it was superseded (for observability).
 */
export interface Supersession {
	toolCallId: string;
	reason: string;
	/** The tool_call_id of the call that supersedes this one. Undefined for self-supersession (e.g. failed bash). */
	supersedingId?: string;
}

/**
 * Information about a single tool invocation extracted from the message stream.
 */
interface ToolInvocation {
	/** Index of the ToolMessage in the message array. */
	resultIndex: number;
	/** The tool_call_id linking assistant → tool result. */
	toolCallId: string;
	/** Tool name (e.g. "read_file", "bash"). */
	toolName: string;
	/** Parsed arguments from the assistant's tool_call. */
	args: Record<string, unknown>;
	/** The tool result content. */
	content: string;
}

// ---------------------------------------------------------------------------
// Extraction: walk messages and collect tool invocations in order
// ---------------------------------------------------------------------------

/**
 * Extract all tool invocations from the message stream, preserving order.
 */
function extractInvocations(messages: Message[]): ToolInvocation[] {
	// First pass: map tool_call_id → { toolName, args }
	const callInfoMap = new Map<string, { toolName: string; args: Record<string, unknown> }>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!assistantMsg.tool_calls) continue;

		for (const tc of assistantMsg.tool_calls) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				args = {};
			}
			callInfoMap.set(tc.id, { toolName: tc.function.name, args });
		}
	}

	// Second pass: collect tool result messages
	const invocations: ToolInvocation[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role !== "tool") continue;

		const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
		const info = callInfoMap.get(toolMsg.tool_call_id);
		if (!info) continue;

		invocations.push({
			resultIndex: i,
			toolCallId: toolMsg.tool_call_id,
			toolName: info.toolName,
			args: info.args,
			content: toolMsg.content,
		});
	}

	return invocations;
}

// ---------------------------------------------------------------------------
// Rule 1: Retry / correction — same tool + same primary arg, later call wins
// ---------------------------------------------------------------------------

/** The primary argument that identifies the "target" of each tool. */
const PRIMARY_ARG: Record<string, string> = {
	read_file: "path",
	write_file: "path",
	edit_file: "path",
	file_search: "pattern",
	grep_search: "pattern",
	bash: "command",
	list_directory: "path",
	skill: "name",
};

function detectRetryCorrection(invocations: ToolInvocation[]): Supersession[] {
	const supersessions: Supersession[] = [];
	// Group by (toolName, primaryArgValue); last in group wins
	const groups = new Map<string, ToolInvocation[]>();

	for (const inv of invocations) {
		const primaryKey = PRIMARY_ARG[inv.toolName];
		if (!primaryKey) continue;
		const argValue = inv.args[primaryKey];
		if (typeof argValue !== "string") continue;

		let groupKey = `${inv.toolName}:${argValue}`;
		// For read_file, include from/to in the key so different ranges aren't grouped
		if (inv.toolName === "read_file") {
			const from = inv.args.from;
			const to = inv.args.to;
			groupKey = `${groupKey}:${from ?? ""}:${to ?? ""}`;
		}
		const group = groups.get(groupKey);
		if (group) {
			group.push(inv);
		} else {
			groups.set(groupKey, [inv]);
		}
	}

	for (const [, group] of groups) {
		if (group.length <= 1) continue;
		// All except the last are superseded; the last element is the superseder
		const superseder = group[group.length - 1];
		if (!superseder) continue;
		for (let i = 0; i < group.length - 1; i++) {
			const inv = group[i];
			if (!inv) continue;
			supersessions.push({
				toolCallId: inv.toolCallId,
				reason: `superseded by later ${inv.toolName} call with same args`,
				supersedingId: superseder.toolCallId,
			});
		}
	}

	return supersessions;
}

// ---------------------------------------------------------------------------
// Rule 2: Re-read after edit — read_file on a path that was later edited/written
// ---------------------------------------------------------------------------

function detectStaleReads(invocations: ToolInvocation[]): Supersession[] {
	const supersessions: Supersession[] = [];

	// Collect all file paths that were written/edited, with the latest invocation index and its toolCallId
	const writtenPaths = new Map<string, { resultIndex: number; toolCallId: string }>();

	for (const inv of invocations) {
		if (inv.toolName !== "write_file" && inv.toolName !== "edit_file") continue;
		const path = typeof inv.args.path === "string" ? inv.args.path : null;
		if (!path) continue;

		const existing = writtenPaths.get(path);
		if (existing === undefined || inv.resultIndex > existing.resultIndex) {
			writtenPaths.set(path, { resultIndex: inv.resultIndex, toolCallId: inv.toolCallId });
		}
	}

	// Any read_file that happened BEFORE the latest write/edit to the same path is stale
	for (const inv of invocations) {
		if (inv.toolName !== "read_file") continue;
		const path = typeof inv.args.path === "string" ? inv.args.path : null;
		if (!path) continue;

		const writeInfo = writtenPaths.get(path);
		if (writeInfo !== undefined && inv.resultIndex < writeInfo.resultIndex) {
			supersessions.push({
				toolCallId: inv.toolCallId,
				reason: `stale read: file was later modified by edit_file or write_file`,
				supersedingId: writeInfo.toolCallId,
			});
		}
	}

	return supersessions;
}

// ---------------------------------------------------------------------------
// Rule 3: Failed bash — non-zero exit code outputs are lower priority
// ---------------------------------------------------------------------------

function detectFailedBash(invocations: ToolInvocation[]): Supersession[] {
	const supersessions: Supersession[] = [];

	for (const inv of invocations) {
		if (inv.toolName !== "bash") continue;

		// Check for non-zero exit code or timeout in the output
		const lines = inv.content.split("\n");
		const lastLine = lines[lines.length - 1] ?? "";
		const secondLast = lines.length >= 2 ? (lines[lines.length - 2] ?? "") : "";

		const exitLine = lastLine.startsWith("exit code:") ? lastLine : secondLast.startsWith("exit code:") ? secondLast : null;

		if (exitLine && !exitLine.includes("exit code: 0")) {
			supersessions.push({
				toolCallId: inv.toolCallId,
				reason: `failed bash command (${exitLine.trim()})`,
			});
		}

		if (lastLine.startsWith("Command timed out") || secondLast.startsWith("Command timed out")) {
			supersessions.push({
				toolCallId: inv.toolCallId,
				reason: "bash command timed out",
			});
		}
	}

	return supersessions;
}

// ---------------------------------------------------------------------------
// Rule 4: Search refinement — repeated search tool, only last matters
// ---------------------------------------------------------------------------

/**
 * Searches (file_search, grep_search) where the same tool is called multiple
 * times, earlier calls are considered refinements and superseded. This is
 * different from retry/correction (Rule 1) because it applies even when the
 * pattern argument is different — the assumption is the user refined their search.
 *
 * This only triggers when there are 2+ calls to the same search tool.
 */
function detectSearchRefinement(invocations: ToolInvocation[]): Supersession[] {
	const supersessions: Supersession[] = [];
	const searchTools = new Set(["file_search", "grep_search"]);

	const groups = new Map<string, ToolInvocation[]>();
	for (const inv of invocations) {
		if (!searchTools.has(inv.toolName)) continue;
		const group = groups.get(inv.toolName);
		if (group) {
			group.push(inv);
		} else {
			groups.set(inv.toolName, [inv]);
		}
	}

	for (const [, group] of groups) {
		if (group.length <= 1) continue;
		// All except the last are superseded; the last element is the superseder
		const superseder = group[group.length - 1];
		if (!superseder) continue;
		for (let i = 0; i < group.length - 1; i++) {
			const inv = group[i];
			if (!inv) continue;
			supersessions.push({
				toolCallId: inv.toolCallId,
				reason: `superseded by later ${inv.toolName} refinement`,
				supersedingId: superseder.toolCallId,
			});
		}
	}

	return supersessions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The strength multiplier applied to superseded messages.
 * This boosts their compaction strength significantly so they are compacted
 * more aggressively than normal messages.
 */
export const SUPERSESSION_STRENGTH_BOOST = 1.5;

/**
 * Detect superseded tool messages across all heuristic rules.
 *
 * Returns a set of tool_call_ids that have been superseded along with reasons.
 * The engine uses this to boost compaction strength for these messages.
 */
export function detectSupersessions(messages: Message[]): Supersession[] {
	const invocations = extractInvocations(messages);

	// Run all heuristic rules. Later rules may produce duplicates for the same
	// tool_call_id — we deduplicate by keeping the first reason found.
	const all = [
		...detectRetryCorrection(invocations),
		...detectStaleReads(invocations),
		...detectFailedBash(invocations),
		...detectSearchRefinement(invocations),
	];

	// Deduplicate: first reason wins per tool_call_id
	const seen = new Set<string>();
	const unique: Supersession[] = [];
	for (const s of all) {
		if (!seen.has(s.toolCallId)) {
			seen.add(s.toolCallId);
			unique.push(s);
		}
	}

	return unique;
}

/**
 * Apply supersession markers to tool messages.
 *
 * For superseded messages that don't have a compaction strength yet (because
 * context pressure is too low), this replaces their content with a short
 * COMPACTED notice. For messages that already have strength, the engine
 * multiplies their strength by SUPERSESSION_STRENGTH_BOOST.
 *
 * @returns Map from tool_call_id to supersession reason (for observability)
 */
export function buildSupersessionMap(supersessions: Supersession[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const s of supersessions) {
		map.set(s.toolCallId, s.reason);
	}
	return map;
}

/**
 * Create a short replacement for a fully superseded tool message.
 */
export function supersededMarker(toolName: string, reason: string): string {
	return `${COMPACTION_MARKER} ${toolName} output superseded: ${reason}`;
}
