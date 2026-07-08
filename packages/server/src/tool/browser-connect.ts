import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { connectCdp, disconnectCdp } from "./browser-cdp";
import type { Tool, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

export const browserConnectTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "browser_connect",
			description:
				"Connect to a Chrome instance via Chrome DevTools Protocol and list all open tabs. " +
				"Chrome must be started with --remote-debugging-port=<port>. " +
				"Use this to discover tabs, then use browser_evaluate to interact with them. " +
				"Subsequent browser calls target tabs from this connection.",
			parameters: {
				type: "object",
				properties: {
					endpoint: {
						type: "string",
						description:
							'CDP HTTP endpoint, e.g. "localhost:9222". Chrome must be started with --remote-debugging-port=<port>.',
					},
				},
				required: ["endpoint"],
			},
		},
	},

	mergeable: false,
	baseDistance: 150,
	outputThreshold: 0.35,

	formatCall(args: Record<string, unknown>): string {
		const endpoint = typeof args.endpoint === "string" ? args.endpoint : "?";
		return `▸ Connecting to Chrome at ${escapeMarkdown(endpoint)}`;
	},

	compact(output: string): string {
		if (output.startsWith("Error")) return output;
		if (output.startsWith("Connected")) {
			return `${COMPACTION_MARKER} ${output.split("\n")[0]}`;
		}
		return output;
	},

	async execute(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolResult> {
		const endpoint = typeof args.endpoint === "string" ? args.endpoint : "";

		if (!endpoint) {
			return {
				llmOutput: "Error: endpoint is required (e.g. 'localhost:9222')",
				uiOutput: "Error: endpoint is required",
				mergeable: false,
			};
		}

		try {
			const tabs = await connectCdp(endpoint, ctx.signal);

			if (tabs.length === 0) {
				return {
					llmOutput: `Connected to ${endpoint}. No open tabs found.`,
					uiOutput: `▸ Connected to ${escapeMarkdown(endpoint)} — no tabs`,
					mergeable: false,
				};
			}

			const tabList = tabs.map((t, i) => `${i + 1}. "${t.title || "(untitled)"}" — ${t.url}`).join("\n");

			return {
				llmOutput: `Connected to ${endpoint}. Open tabs:\n\n${tabList}\n\nUse browser_evaluate with a tab name, URL substring, or to interact with a specific tab. If you omit the tab parameter, the most recently used tab will be targeted.`,
				uiOutput: `▸ Connected to ${escapeMarkdown(endpoint)}\n\n${tabList}`,
				mergeable: false,
			};
		} catch (err) {
			const msg = `Error: ${(err as Error).message}`;
			disconnectCdp(); // Clean up partial connections
			return {
				llmOutput: msg,
				uiOutput: msg,
				mergeable: false,
			};
		}
	},
};
