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
	usage: number;
	iterations: number;
	charsBefore: number;
	charsAfter: number;
	charBudget: number;
	charsPerToken: number;
	type: string;
	parameters: {
		threshold: number;
		inflection: number;
		steepness: number;
		maxAgeDistance: number;
	};
	estimatedContextNeeded: number;
	target: number;
	elapsedMs: number;
}

export interface CompactionDetail {
	age: number;
	compactionFactor: number;
	position: number;
	normalizedPosition: number;
	distance: number;
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
	detailParts.push(`position=${detail.normalizedPosition.toFixed(2)}`);
	detailParts.push(`factor=${detail.compactionFactor.toFixed(3)}`);

	if (detail.outputThreshold !== undefined) {
		detailParts.push(`output=${detail.outputThreshold.toFixed(2)}`);
	}
	if (detail.argsThreshold !== undefined) {
		detailParts.push(`arguments=${detail.argsThreshold.toFixed(2)}`);
	}

	// Action
	if (detail.wasCompacted || detail.savedArgsChars !== undefined) {
		detailParts.push("compacted");
	} else if (detail.belowMinSavings) {
		detailParts.push("too small");
	} else {
		detailParts.push("no change");
	}

	// Token savings (only when something was saved)
	const totalSavedChars = (detail.savedChars ?? 0) + (detail.savedArgsChars ?? 0);
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

export function generateFactorsTable(threshold: number, inflection: number, steepness: number): number[][] {
	const steps = Array.from({ length: 21 }, (_, i) => i * 0.05);
	return steps.map((usage) => {
		const pressure = usage <= threshold ? 0 : Math.min(1, (usage - threshold) / (1 - threshold));
		return steps.map((normPos) => {
			const raw = Math.atan(steepness * (inflection - normPos));
			const rawMin = Math.atan(steepness * (inflection - 1));
			const rawMax = Math.atan(steepness * inflection);
			const age = (raw - rawMin) / (rawMax - rawMin);
			return pressure * age;
		});
	});
}

export function formatCompactionSummary(stats: CompactionStats): string {
	const sections: string[] = [];

	// Section 1: Compaction parameters
	sections.push("# Compaction parameters");
	sections.push(`- threshold: ${stats.parameters.threshold}`);
	sections.push(`- inflection: ${stats.parameters.inflection}`);
	sections.push(`- steepness: ${stats.parameters.steepness}`);
	sections.push(`- max age distance: ${stats.parameters.maxAgeDistance}`);
	sections.push("");

	// Section 2: Factors table
	sections.push("# Usage vs. normalized position");
	sections.push("");
	const table = generateFactorsTable(stats.parameters.threshold, stats.parameters.inflection, stats.parameters.steepness);
	const steps = Array.from({ length: 21 }, (_, i) => (i * 0.05).toFixed(2));

	// Header row
	sections.push(`|  | ${steps.join(" | ")} |`);
	sections.push(`|---|${steps.map(() => "---").join("|")}|`);

	// Data rows
	for (let r = 0; r < table.length; r++) {
		const rowLabel = steps[r];
		const cells = (table[r] as number[]).map((v) => v.toFixed(2));
		sections.push(`| ${rowLabel} | ${cells.join(" | ")} |`);
	}

	sections.push("");
	sections.push("- horizontal: normalized message position");
	sections.push("- vertical: calculated compaction usage");
	sections.push("");

	// Section 3: Compaction details
	sections.push("# Compaction details");
	sections.push(`- target context usage: ${(stats.target * 100).toFixed(0)}%`);
	sections.push(`- estimated context needed: ${(stats.estimatedContextNeeded * 100).toFixed(0)}%`);
	sections.push(`- average characters per token: ${stats.charsPerToken.toFixed(2)}`);
	sections.push(`- total content before compaction: ${stats.charsBefore} characters`);
	sections.push(`- total content after compaction: ${stats.charsAfter} characters`);
	sections.push(`- calculated compaction usage: ${(stats.usage * 100).toFixed(0)}%`);
	sections.push(`- compaction iterations: ${stats.iterations}`);
	sections.push(`- compaction time: ${stats.elapsedMs.toFixed(1)}ms`);

	return sections.join("\n");
}
