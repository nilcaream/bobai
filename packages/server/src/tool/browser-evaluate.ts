import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { evaluateCdp, type PageSnapshot, parseTabSpec } from "./browser-cdp";
import type { Tool, ToolResult } from "./tool";

function formatPageContext(snapshot: PageSnapshot): string {
	const parts: string[] = [];

	parts.push(`**Page:** ${snapshot.title || "(untitled)"}`);
	parts.push(`URL: ${snapshot.url}`);

	if (snapshot.inputs.length > 0) {
		const inputDescs = snapshot.inputs.map(
			(i) => `- \`${i.selector}\` (${i.type})${i.id ? ` #${i.id}` : ""}${i.name ? ` name="${i.name}"` : ""}`,
		);
		parts.push(`**Inputs:**\n${inputDescs.join("\n")}`);
	}

	if (snapshot.buttons.length > 0) {
		parts.push(`**Buttons:** ${snapshot.buttons.join(", ")}`);
	}

	if (snapshot.links.length > 0) {
		const linkDescs = snapshot.links.slice(0, 10).map((l) => `- [${l.text || l.href}](${l.href})`);
		parts.push(`**Links (first ${Math.min(10, snapshot.links.length)}):**\n${linkDescs.join("\n")}`);
	}

	return parts.join("\n");
}

/**
 * Returns a short label for the UI panel.
 * Uses the explicit label if provided, otherwise returns "Running script".
 */
function getLabel(explicit?: string): string {
	return explicit ?? "Running script";
}

export const browserEvaluateTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "browser_evaluate",
			description:
				"Execute JavaScript in a browser tab and return the result. " +
				"The script runs in an async context — you can use await, Promises, try/catch, etc. " +
				"Use this for EVERYTHING: reading page content, filling forms, clicking buttons, " +
				"waiting for elements, extracting data, scrolling, checking state.\n\n" +
				"IMPORTANT: Bob AI automatically includes a page snapshot (inputs, buttons, links) " +
				"with every result — you don't need to separately query for available elements. " +
				"Bob AI also auto-waits for page loads after navigation.\n\n" +
				"You MUST call browser_connect before using this tool.",
			parameters: {
				type: "object",
				properties: {
					tab: {
						type: "string",
						description:
							'Which tab to target. Can be a name substring ("News"), URL substring ("portal.example.com"), or omitted to use the most recently referenced tab.',
					},
					expression: {
						type: "string",
						description:
							"JavaScript to execute in the page. Can be multiline. " +
							"The expression is wrapped in an async IIFE with an implicit return — the " +
							"expression's value is automatically returned and JSON-serialized. " +
							"Use await freely for Promises. " +
							"For throw statements, the error message is returned instead. " +
							"NOTE: Write the expression directly (e.g. 'document.title' or " +
							"'document.querySelectorAll(\".foo\").length'). Do NOT wrap your code in " +
							"'() => {...}' or '(() => {...})()' — the tool already wraps it.",
					},
					label: {
						type: "string",
						description: "Short description of what this expression does (max ~10 words). Used for the UI panel label.",
					},
				},
				required: ["expression"],
			},
		},
	},

	mergeable: false,
	baseDistance: 150,
	outputThreshold: 0.35,

	formatCall(_args: Record<string, unknown>): string {
		return "▸ Running browser script\u2026";
	},

	compact(output: string): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		if (lines.length <= 20) return output;
		const head = lines.slice(0, 15).join("\n");
		return `${COMPACTION_MARKER} browser_evaluate — showing first 15 of ${lines.length} lines\n${head}`;
	},

	async execute(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolResult> {
		const expression = typeof args.expression === "string" ? args.expression : "";

		if (!expression.trim()) {
			return {
				llmOutput: "Error: expression is required",
				uiOutput: "Error: expression is required",
				mergeable: false,
			};
		}

		// Parse tab spec — supports numeric index, URL substring, title substring
		const tabSpec = parseTabSpec(args.tab);

		// Build the UI label
		const explicitLabel = typeof args.label === "string" ? args.label : undefined;
		const label = getLabel(explicitLabel);

		try {
			const { result, page, pageState } = await evaluateCdp(tabSpec, expression, ctx.signal);

			const context = formatPageContext(page);

			// Format the response
			const parts: string[] = [];

			// Show the result — note when there was no return value
			if (result === undefined) {
				parts.push("(no return value)");
			} else {
				const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				parts.push(resultStr);
			}

			// Page state
			if (pageState === "closed") {
				parts.push("\n---");
				parts.push(
					"\n🔒 Tab was closed (e.g. by window.close()). The tab has been removed from the tab list. Use browser_connect to refresh the tab list.",
				);
			} else if (pageState === "navigating") {
				parts.push("\n---");
				parts.push("\n⚠️ Page is navigating. The next browser_evaluate will auto-wait for the new page to load.");
			}

			// Page context
			parts.push("\n---");
			parts.push(`\n${context}`);

			// UI output: short label + URL
			const urlSuffix = page.url ? ` — ${page.url}` : "";
			const uiLine = `▸ ${label}${urlSuffix}`;

			return {
				llmOutput: parts.join("\n"),
				uiOutput: uiLine,
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
