import type { GrepToolKind, ShellToolKind } from "../platform/types";
import { bashTool } from "./bash";
import { cmdTool } from "./cmd";
import { findstrTool } from "./findstr";
import { grepSearchTool } from "./grep-search";
import { powershellTool } from "./powershell";
import type { Tool } from "./tool";

const SHELL_TOOLS: Record<ShellToolKind, Tool> = {
	bash: bashTool,
	cmd: cmdTool,
	powershell: powershellTool,
};

const GREP_TOOLS: Record<GrepToolKind, Tool> = {
	grep_search: grepSearchTool,
	findstr: findstrTool,
};

export function getShellTool(kind: ShellToolKind): Tool | undefined {
	return SHELL_TOOLS[kind];
}

export function getGrepTool(kind: GrepToolKind): Tool | undefined {
	return GREP_TOOLS[kind];
}
