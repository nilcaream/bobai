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
	pressure: number;
	iterations: number;
	charsBefore: number;
	charsAfter: number;
	charBudget: number;
	charsPerToken: number;
	type: string;
}

export interface CompactionDetail {
	age: number;
	compactionFactor: number;
	position: number;
	normalizedPosition: number;
	outputThreshold?: number;
	argsThreshold?: number;
	wasCompacted: boolean;
	belowMinSavings?: boolean;
	savedChars?: number;
	savedArgsChars?: number;
}

export function formatToolHeader(
	toolCallId: string,
	toolName: string,
	detail: CompactionDetail | undefined,
	messageIndex?: number,
): string {
	const prefix = messageIndex !== undefined ? `#${messageIndex} ` : "";
	const parts = [`${prefix}tool`, toolCallId, toolName];

	if (!detail) {
		parts.push("no detail available");
		return parts.join(" | ");
	}

	// Position info: both raw and normalized (after MAX_AGE_DISTANCE capping)
	parts.push(`pos=${detail.position.toFixed(3)} norm=${detail.normalizedPosition.toFixed(3)}`);
	parts.push(`age=${detail.age.toFixed(3)}`);
	parts.push(`factor=${detail.compactionFactor.toFixed(3)}`);

	// Show thresholds
	const thresholds: string[] = [];
	if (detail.outputThreshold !== undefined) thresholds.push(`out=${detail.outputThreshold}`);
	if (detail.argsThreshold !== undefined) thresholds.push(`args=${detail.argsThreshold}`);
	if (thresholds.length > 0) parts.push(`threshold(${thresholds.join(", ")})`);

	// Compaction outcome
	if (detail.wasCompacted) {
		if (detail.savedChars !== undefined) {
			const argsSavings = detail.savedArgsChars !== undefined ? ` + ${detail.savedArgsChars} args` : "";
			parts.push(`compacted (saved ${detail.savedChars} chars${argsSavings})`);
		} else if (detail.savedArgsChars !== undefined) {
			parts.push(`args compacted (saved ${detail.savedArgsChars} chars)`);
		} else {
			parts.push("compacted");
		}
	} else if (detail.savedArgsChars !== undefined) {
		parts.push(`args compacted (saved ${detail.savedArgsChars} chars)`);
	} else if (detail.belowMinSavings) {
		parts.push("savings below minimum");
	} else if (detail.compactionFactor <= 0) {
		parts.push("no pressure");
	} else {
		parts.push("kept");
	}

	return parts.join(" | ");
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
	const lines = [
		`budget: ${stats.charBudget}`,
		`pressure: ${stats.pressure.toFixed(2)}`,
		`iterations: ${stats.iterations}`,
		`chars/token: ${stats.charsPerToken.toFixed(2)}`,
		`chars in: ${stats.charsBefore}`,
		`chars out: ${stats.charsAfter}`,
		`type: ${stats.type}`,
	];
	return lines.join("\n");
}
