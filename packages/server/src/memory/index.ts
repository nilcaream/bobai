import type { Memory } from "./repository";

/** Maximum number of memory entries injected into the system prompt index. */
export const MEMORY_INDEX_MAX_ENTRIES = 32;
/** Maximum byte size of the injected index (defense in depth against huge titles/descriptions). */
export const MEMORY_INDEX_MAX_BYTES = 4000;

/** First N characters of a memory id, used as a compact reference in listings. */
export function shortMemoryId(id: string): string {
	return id.slice(0, 8);
}

const DAY_MS = 86_400_000;

/** Whole days elapsed since the memory was last updated (0 = today). */
export function memoryAgeDays(updatedAt: string, now: Date = new Date()): number {
	const updated = new Date(updatedAt).getTime();
	if (Number.isNaN(updated)) return 0;
	return Math.max(0, Math.floor((now.getTime() - updated) / DAY_MS));
}

/** Human-readable age phrase: "today", "yesterday", or "N days ago". */
export function formatMemoryAge(updatedAt: string, now: Date = new Date()): string {
	const days = memoryAgeDays(updatedAt, now);
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	return `${days} days ago`;
}

/** Caveat injected when reading a memory older than one day. Empty for fresh memories. */
export function memoryFreshnessCaveat(updatedAt: string, now: Date = new Date()): string {
	const days = memoryAgeDays(updatedAt, now);
	if (days <= 1) return "";
	return (
		`This memory is ${days} days old. Memories are point-in-time observations, not live state — ` +
		"verify any claims about code behavior against the current codebase before asserting them."
	);
}

/** Short one-line summary for the index, falling back to the first line of content. */
export function memorySummary(memory: Memory): string {
	const source = memory.description?.trim() || memory.content.trim();
	const firstLine = source.split("\n", 1)[0] ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

/**
 * Build the memory index injected into the system prompt.
 * Returns the inner markdown (header + bounded entry list), or "" when there
 * are no memories. Bounded by MEMORY_INDEX_MAX_ENTRIES and MEMORY_INDEX_MAX_BYTES.
 */
export function buildMemoryIndex(memories: Memory[], now: Date = new Date()): string {
	if (memories.length === 0) return "";

	const header = [
		"## Project Memory",
		"",
		"Memories saved in previous sessions. Read a full entry with `memory get <id>`, or search with `memory search <query>`.",
		"",
	].join("\n");

	let bytes = Buffer.byteLength(header, "utf8");
	const lines: string[] = [];
	let shown = 0;

	for (const memory of memories) {
		const line = `- \`${shortMemoryId(memory.id)}\` [${memory.type}] ${memory.title} — ${memorySummary(memory)} (${formatMemoryAge(memory.updatedAt, now)})`;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (shown >= MEMORY_INDEX_MAX_ENTRIES || bytes + lineBytes > MEMORY_INDEX_MAX_BYTES) {
			break;
		}
		lines.push(line);
		bytes += lineBytes;
		shown += 1;
	}

	const body = lines.join("\n");
	const hidden = memories.length - shown;
	const note = hidden > 0 ? `\n\n(… ${hidden} more memories not shown — use \`memory list\` to see all)` : "";

	return `${header}${body}${note}`;
}
