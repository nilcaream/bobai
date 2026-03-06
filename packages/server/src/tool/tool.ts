import type { ToolDefinition } from "../provider/provider";

export interface ToolContext {
	projectRoot: string;
}

export interface ToolResult {
	llmOutput: string;
	uiOutput: string | null;
	mergeable: boolean;
	/** Optional summary line (e.g. subagent turn stats) rendered as a status bar on the tool panel. */
	summary?: string;
}

export interface Tool {
	definition: ToolDefinition;
	mergeable: boolean;
	formatCall(args: Record<string, unknown>): string;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
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
