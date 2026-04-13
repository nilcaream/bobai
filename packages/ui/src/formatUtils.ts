import type { MessagePart } from "./protocol";

export type Panel =
	| { type: "text"; content: string }
	| {
			type: "tool";
			id: string;
			content: string;
			completed: boolean;
			mergeable: boolean;
			summary?: string;
			subagentSessionId?: string;
	  };

export interface ContextMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	metadata: Record<string, unknown> | null;
	messageIndex?: number;
}

export interface CompactionStats {
	multiplier: number;
	iterations: number;
	charsBefore: number;
	charsAfter: number;
	charBudget: number;
	charsPerToken: number;
	type: string;
	parameters: {
		defaultMaxDistance: number;
	};
	estimatedContextNeeded: number;
	target: number;
	elapsedMs: number;
	messagesBefore: Record<string, number>;
	messagesAfter: Record<string, number>;
	toolReach?: ToolReachEntry[];
}

export interface ToolReachEntry {
	name: string;
	type: "output" | "arguments";
	threshold: number;
	maxDistance: number;
	minimumDistance: number;
	evictionDistance: number;
	compactedFrom: number | null;
}

export interface CompactionDetail {
	distance: number;
	compactionFactor: number;
	maxDistance: number;
	outputThreshold?: number;
	argsThreshold?: number;
	wasCompacted: boolean;
	wasEvicted: boolean;
	belowMinSavings?: boolean;
	savedChars: number;
	savedArgsChars: number;
}

export function formatToolHeader(
	toolCallId: string,
	toolName: string,
	detail: CompactionDetail | undefined,
	messageIndex?: number,
	charsPerToken?: number,
): string {
	const prefix = messageIndex !== undefined ? `#${messageIndex} ` : "";
	const idParts = [`${prefix}tool`, toolCallId, toolName];

	if (!detail) {
		idParts.push("excluded");
		return idParts.join(" | ");
	}

	const detailParts: string[] = [];
	detailParts.push(`distance=${detail.distance}`);
	detailParts.push(`factor=${detail.compactionFactor.toFixed(3)}`);

	if (detail.outputThreshold !== undefined) {
		detailParts.push(`output=${detail.outputThreshold.toFixed(2)}`);
	}
	if (detail.argsThreshold !== undefined) {
		detailParts.push(`arguments=${detail.argsThreshold.toFixed(2)}`);
	}

	// Action
	if (detail.wasEvicted) {
		detailParts.push("evicted");
	} else if (detail.wasCompacted || detail.savedArgsChars > 0) {
		detailParts.push("compacted");
	} else if (detail.belowMinSavings) {
		detailParts.push("too small");
	} else {
		detailParts.push("no change");
	}

	// Token savings (only when something was saved)
	const totalSavedChars = detail.savedChars + detail.savedArgsChars;
	if (totalSavedChars > 0 && charsPerToken && charsPerToken > 0) {
		const savedTokens = Math.round(totalSavedChars / charsPerToken);
		detailParts.push(`tokens=-${savedTokens}`);
	}

	return `${idParts.join(" | ")} | ${detailParts.join(" | ")}`;
}

export function groupParts(parts: MessagePart[]): Panel[] {
	// Pass 1: Create panels for each part
	const raw: Panel[] = [];
	const toolPanelMap = new Map<string, Panel & { type: "tool" }>();

	for (const part of parts) {
		if (part.type === "text") {
			raw.push({ type: "text", content: part.content });
		} else if (part.type === "tool_call") {
			const panel: Panel & { type: "tool" } = {
				type: "tool",
				id: part.id,
				content: part.content,
				completed: false,
				mergeable: false,
			};
			raw.push(panel);
			toolPanelMap.set(part.id, panel);
		} else if (part.type === "tool_result") {
			const panel = toolPanelMap.get(part.id);
			if (panel) {
				if (part.content !== null) {
					panel.content = part.content;
				}
				panel.completed = true;
				panel.mergeable = part.mergeable;
				if (part.summary) {
					panel.summary = part.summary;
				}
				if (part.subagentSessionId) {
					panel.subagentSessionId = part.subagentSessionId;
				}
			}
		}
	}

	// Pass 2: Merge adjacent completed+mergeable tool panels
	const merged: Panel[] = [];
	for (const panel of raw) {
		const prev = merged.at(-1);
		if (
			panel.type === "tool" &&
			panel.completed &&
			panel.mergeable &&
			prev?.type === "tool" &&
			prev.completed &&
			prev.mergeable
		) {
			prev.content = `${prev.content}  \n${panel.content}`;
		} else {
			merged.push(panel);
		}
	}

	return merged;
}

export function formatMsgSummary(msg: { summary?: string; model?: string }): string {
	return msg.summary ?? (msg.model ? ` | ${msg.model}` : "");
}

export function truncateContent(text: string, lineLimit: number): string {
	const trimmed = text.trim();
	if (lineLimit <= 0) return trimmed;
	const lines = trimmed.split("\n");
	if (lines.length <= lineLimit) return trimmed;
	const headCount = 20;
	const tailCount = 20;
	const omitted = lines.length - headCount - tailCount;
	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	return `${head}\n... (${omitted} more lines)\n${tail}`;
}

export function truncateChars(text: string, charLimit: number): string {
	if (charLimit <= 0 || text.length <= charLimit) return text;
	return `${text.slice(0, charLimit)}... (${text.length - charLimit} more chars)`;
}

export function formatCompactionSummary(stats: CompactionStats): string {
	const sections: string[] = [];

	// Section 1: Compaction parameters
	sections.push("# Compaction parameters");
	sections.push(`- default max distance: ${stats.parameters.defaultMaxDistance}`);
	sections.push("");

	// Section 2: Compaction details
	sections.push("# Compaction details");
	sections.push(`- target context usage: ${(stats.target * 100).toFixed(0)}%`);
	sections.push(`- estimated context needed: ${(stats.estimatedContextNeeded * 100).toFixed(0)}%`);
	sections.push(`- average characters per token: ${stats.charsPerToken.toFixed(2)}`);
	sections.push(`- total content before compaction: ${stats.charsBefore} characters`);
	sections.push(`- total content after compaction: ${stats.charsAfter} characters`);
	sections.push(`- calculated multiplier: ${stats.multiplier.toFixed(2)}`);
	sections.push(`- compaction iterations: ${stats.iterations}`);
	sections.push(`- compaction time: ${stats.elapsedMs.toFixed(1)}ms`);
	sections.push("");

	// Section 3: Context details (message counts by role)
	sections.push("# Context details");
	sections.push("");
	const roles = ["total", "system", "user", "assistant", "tool"];
	// Include any roles present in the data but not in the default list
	for (const role of Object.keys(stats.messagesBefore)) {
		if (!roles.includes(role)) roles.push(role);
	}
	for (const role of Object.keys(stats.messagesAfter)) {
		if (!roles.includes(role)) roles.push(role);
	}
	sections.push("| | before | after |");
	sections.push("|---|---|---|");
	for (const role of roles) {
		const before = stats.messagesBefore[role] ?? 0;
		const after = stats.messagesAfter[role] ?? 0;
		sections.push(`| ${role} | ${before} | ${after} |`);
	}

	// Section 4: Compaction reach at current multiplier
	if (stats.toolReach && stats.toolReach.length > 0) {
		sections.push("");
		sections.push(`# Compaction reach at current multiplier (${stats.multiplier.toFixed(2)})`);
		sections.push("");
		sections.push("| role / tool | type | threshold | max distance | minimum distance | eviction distance | compacted from |");
		sections.push("|---|---|---|---|---|---|---|");
		for (const entry of stats.toolReach) {
			if (entry.threshold === -1) {
				// Excluded role (user, assistant, system)
				sections.push(`| ${entry.name} | — | — | — | — | — | excluded |`);
			} else if (entry.minimumDistance === 0) {
				sections.push(
					`| ${entry.name} | ${entry.type} | ${entry.threshold.toFixed(2)} | ${entry.maxDistance} | — | — | never |`,
				);
			} else {
				sections.push(
					`| ${entry.name} | ${entry.type} | ${entry.threshold.toFixed(2)} | ${entry.maxDistance} | ${entry.minimumDistance} | ${entry.evictionDistance} | #${entry.compactedFrom} |`,
				);
			}
		}
	}

	return sections.join("\n");
}
