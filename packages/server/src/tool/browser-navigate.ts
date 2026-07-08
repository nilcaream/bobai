import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { navigateCdp } from "./browser-cdp";
import type { Tool, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

function formatSnapshot(snapshot: { url: string; title: string; bodyText: string }): string {
	const parts: string[] = [];
	if (snapshot.title) parts.push(`**${snapshot.title}**`);
	parts.push(`URL: ${snapshot.url}`);
	if (snapshot.bodyText) {
		parts.push("");
		parts.push("---");
		parts.push("");
		parts.push(snapshot.bodyText);
	}
	return parts.join("\n");
}

export const browserNavigateTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "browser_navigate",
			description:
				"Open a new browser tab, navigate to a URL, and return the page content. " +
				"The new tab becomes the active tab for subsequent browser_evaluate calls. " +
				"Waits for the page to fully load before returning.\n\n" +
				"Set reuse: true to navigate the active tab instead of opening a new one.",
			parameters: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "Full URL to navigate to (must start with http:// or https://).",
					},
					reuse: {
						type: "boolean",
						description: "If true, navigate the active tab instead of opening a new one. Defaults to false.",
					},
				},
				required: ["url"],
			},
		},
	},

	mergeable: false,
	baseDistance: 150,
	outputThreshold: 0.35,

	formatCall(args: Record<string, unknown>): string {
		const url = typeof args.url === "string" ? args.url : "?";
		return `▸ Reading ${escapeMarkdown(url)}`;
	},

	compact(output: string): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		if (lines.length <= 15) return output;
		const head = lines.slice(0, 10).join("\n");
		return `${COMPACTION_MARKER} browser_navigate — showing first 10 of ${lines.length} lines\n${head}`;
	},

	async execute(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolResult> {
		const url = typeof args.url === "string" ? args.url : "";

		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			return {
				llmOutput: "Error: URL must start with http:// or https://",
				uiOutput: "Error: URL must start with http:// or https://",
				mergeable: false,
			};
		}

		try {
			const reuse = args.reuse === true;
			const { tabId, snapshot } = await navigateCdp(url, ctx.signal, reuse);

			const formatted = formatSnapshot(snapshot);

			// Build structured info for the LLM
			const parts: string[] = [`Opened new tab and navigated to ${url}`];
			parts.push("");
			parts.push(formatted);
			parts.push("");
			parts.push(`Tab is ready for interaction. Use browser_evaluate to interact with this page.`);

			const tabLabel = snapshot.title || url;
			const uiLine = snapshot.url ? `▸ Reading "${tabLabel}" — ${snapshot.url}` : `▸ Reading ${escapeMarkdown(url)}`;

			return {
				llmOutput: parts.join("\n"),
				uiOutput: uiLine,
				mergeable: false,
				metadata: { tabId },
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
