import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { closeTabCdp, parseTabSpec } from "./browser-cdp";
import type { Tool, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

export const browserCloseTabTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "browser_close_tab",
			description:
				"Close a browser tab by its name, URL substring, or index. " +
				"If no tab is specified, closes the active tab. " +
				"The tab list is updated automatically.",
			parameters: {
				type: "object",
				properties: {
					tab: {
						type: "string",
						description:
							"Which tab to close. Can be a name substring, URL substring, tab index (e.g. '3'), or omitted to close the active tab.",
					},
				},
				required: [],
			},
		},
	},

	mergeable: false,
	baseDistance: 150,
	outputThreshold: 0.35,

	formatCall(args: Record<string, unknown>): string {
		const tab = typeof args.tab === "string" ? args.tab : "active tab";
		return `▸ Closing tab "${escapeMarkdown(tab)}"`;
	},

	compact(output: string): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		if (lines.length <= 5) return output;
		return `${COMPACTION_MARKER} browser_close_tab — ${lines[0]}`;
	},

	async execute(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolResult> {
		const tabSpec = parseTabSpec(args.tab);

		try {
			const info = await closeTabCdp(tabSpec, ctx.signal);

			return {
				llmOutput: `Closed tab "${info.title}" (${info.url}).\n\nRemaining tabs: ${info.remainingCount}`,
				uiOutput: `▸ Closed "${info.title}" — ${info.url}`,
				mergeable: false,
			};
		} catch (err) {
			const msg = `Error: ${(err as Error).message}`;
			return {
				llmOutput: msg,
				uiOutput: msg,
				mergeable: false,
			};
		}
	},
};
