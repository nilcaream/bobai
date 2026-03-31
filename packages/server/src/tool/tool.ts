import path from "node:path";
import type { ToolDefinition } from "../provider/provider";

export interface ToolContext {
	projectRoot: string;
	/** Additional directories the read-only tools (read_file, grep_search, list_directory, file_search) may access. */
	accessibleDirectories?: string[];
	/** Session identifier for FileTime tracking. */
	sessionId: string;
	/** The provider-assigned tool_call ID for this invocation (used by the task tool to link subagent sessions). */
	toolCallId?: string;
}

/** Check whether a resolved absolute path falls within the project root or any accessible directory. */
export function isPathAccessible(resolved: string, ctx: ToolContext): boolean {
	if (resolved === ctx.projectRoot || resolved.startsWith(ctx.projectRoot + path.sep)) {
		return true;
	}
	for (const dir of ctx.accessibleDirectories ?? []) {
		if (resolved === dir || resolved.startsWith(dir + path.sep)) {
			return true;
		}
	}
	return false;
}

/** Escape characters that have special meaning in Markdown so they render as literal text. */
export function escapeMarkdown(text: string): string {
	return text.replace(/([*_`~\\[\]|#>])/g, "\\$1");
}

export interface ToolResult {
	llmOutput: string;
	uiOutput: string | null;
	mergeable: boolean;
	/** Optional summary line (e.g. subagent turn stats) rendered as a status bar on the tool panel. */
	summary?: string;
	/** Optional metadata to persist alongside the tool message in the DB. */
	metadata?: Record<string, unknown>;
}

export interface Tool {
	definition: ToolDefinition;
	mergeable: boolean;
	/**
	 * Compaction factor threshold for output compaction (0.0-1.0).
	 * When contextPressure × age exceeds this, compact() is called.
	 * Undefined means output is never compacted.
	 */
	outputThreshold?: number;
	/**
	 * Compaction factor threshold for argument compaction (0.0-1.0).
	 * When contextPressure × age exceeds this, compactArgs() is called.
	 * Undefined means arguments are never compacted.
	 */
	argsThreshold?: number;
	formatCall(args: Record<string, unknown>): string;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
	/**
	 * Compact tool output. Called when compactionFactor exceeds outputThreshold.
	 * Returns compacted output string.
	 */
	compact?(output: string, callArgs: Record<string, unknown>, context?: { sessionId: string; toolCallId: string }): string;
	/**
	 * Compact tool_call arguments. Called when compactionFactor exceeds argsThreshold.
	 * Returns new args object with compacted values.
	 */
	compactArgs?(args: Record<string, unknown>): Record<string, unknown>;
}

export interface ToolRegistry {
	definitions: ToolDefinition[];
	get(name: string): Tool | undefined;
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
	const map = new Map<string, Tool>();
	for (const tool of tools) {
		map.set(tool.definition.function.name, tool);
	}
	return {
		definitions: tools.map((t) => t.definition),
		get(name: string) {
			return map.get(name);
		},
	};
}
