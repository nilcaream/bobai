import type { ToolDefinition } from "../provider/provider";

export interface ToolContext {
	projectRoot: string;
}

export interface ToolResult {
	output: string;
	isError?: boolean;
}

export interface Tool {
	definition: ToolDefinition;
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
