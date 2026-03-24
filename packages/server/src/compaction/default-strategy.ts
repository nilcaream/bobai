/** Minimum number of lines to keep even at maximum compaction. */
const MIN_KEEP_LINES = 3;

/** The magic marker prefix used in all compaction notices. */
export const COMPACTION_MARKER = "# COMPACTED";

/**
 * Default compaction strategy: keep the first N lines of the output
 * and append a truncation notice with the COMPACTED marker.
 *
 * The number of retained lines scales inversely with strength:
 * - strength 0.0 → keep all lines (no compaction)
 * - strength 0.5 → keep ~50% of lines
 * - strength 1.0 → keep MIN_KEEP_LINES
 *
 * @param output - The original tool output
 * @param strength - Compaction strength (0.0-1.0)
 * @param toolName - Name of the tool (for the notice)
 * @returns The compacted output, or the original if no compaction needed
 */
export function defaultCompact(output: string, strength: number, toolName: string): string {
	if (strength <= 0) return output;

	const lines = output.split("\n");
	const totalLines = lines.length;

	if (totalLines <= MIN_KEEP_LINES) return output;

	const keepRatio = 1 - strength;
	const keepCount = Math.max(MIN_KEEP_LINES, Math.floor(totalLines * keepRatio));

	if (keepCount >= totalLines) return output;

	const kept = lines.slice(0, keepCount).join("\n");
	const removed = totalLines - keepCount;
	return `${kept}\n${COMPACTION_MARKER} ${removed} more lines from ${toolName} output truncated`;
}

/**
 * Compact a tool_call argument value (e.g. the `content` field of a write_file call).
 *
 * Same line-based truncation as defaultCompact but with a marker that identifies
 * the field as an argument rather than tool output.
 *
 * @param value - The argument string value
 * @param strength - Compaction strength (0.0-1.0)
 * @param toolName - Name of the tool (for the notice)
 * @param argName - Name of the argument field (for the notice)
 * @returns The compacted value, or the original if no compaction needed
 */
export function compactArgument(value: string, strength: number, toolName: string, argName: string): string {
	if (strength <= 0) return value;

	const lines = value.split("\n");
	const totalLines = lines.length;

	if (totalLines <= MIN_KEEP_LINES) return value;

	const keepRatio = 1 - strength;
	const keepCount = Math.max(MIN_KEEP_LINES, Math.floor(totalLines * keepRatio));

	if (keepCount >= totalLines) return value;

	const kept = lines.slice(0, keepCount).join("\n");
	const removed = totalLines - keepCount;
	return `${kept}\n${COMPACTION_MARKER} ${removed} lines from ${toolName} ${argName} argument omitted`;
}
