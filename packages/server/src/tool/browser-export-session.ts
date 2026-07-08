import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { exportSessionCdp, parseTabSpec } from "./browser-cdp";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

export const browserExportSessionTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "browser_export_session",
			description:
				"Extract cookies and localStorage from a browser tab's origin. " +
				"Use this to replicate an authenticated session for curl, wget, or other " +
				"command-line tools — e.g. batch downloading files without going through the browser. " +
				"The 'curlCookie' value can be used directly with curl's -b flag. " +
				"Cookies include HttpOnly cookies (invisible to document.cookie).",
			parameters: {
				type: "object",
				properties: {
					tab: {
						type: "string",
						description: "Which tab to extract from. Can be a name substring, URL substring, or omitted to use the active tab.",
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
		return `▸ Exporting session from ${escapeMarkdown(tab)}`;
	},

	compact(output: string): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		if (lines.length <= 10) return output;
		const head = lines.slice(0, 5).join("\n");
		return `${COMPACTION_MARKER} browser_export_session — ${head}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		// Parse tab spec — supports numeric index, URL substring, title substring
		const tabSpec = parseTabSpec(args.tab);

		try {
			const session = await exportSessionCdp(tabSpec, ctx.signal);

			// Save session to disk if we have the necessary context
			let filePath: string | undefined;
			if (ctx.projectRoot && ctx.sessionId) {
				filePath = `.bobai/downloads/${ctx.sessionId}/${ctx.toolCallId ?? "session"}.json`;
				const fullPath = `${ctx.projectRoot}/${filePath}`;
				const sessionData = JSON.stringify(
					{
						origin: session.origin,
						curlCookie: session.curlCookie,
						headers: session.headers,
						cookies: session.raw.cookies,
						localStorage: session.raw.localStorage,
					},
					null,
					2,
				);
				await Bun.write(fullPath, sessionData);
			}

			// Format for the LLM
			const parts: string[] = [];
			parts.push(`**Origin:** ${session.origin}`);
			if (filePath) {
				parts.push(`**Saved to:** ${filePath}`);
			}
			parts.push("");
			parts.push(`**curl cookie string (use with -b):**`);
			parts.push(`\`${session.curlCookie}\``);
			parts.push("");

			if (Object.keys(session.headers).length > 0) {
				parts.push("**Headers (include in requests):**");
				for (const [key, value] of Object.entries(session.headers)) {
					parts.push(`- \`${key}: ${value.slice(0, 100)}${value.length > 100 ? "..." : ""}\``);
				}
				parts.push("");
			}

			parts.push(`**Cookies (${session.raw.cookies.length}):**`);
			for (const c of session.raw.cookies) {
				const flags: string[] = [];
				if (c.httpOnly) flags.push("HttpOnly");
				if (c.secure) flags.push("Secure");
				const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
				parts.push(`- \`${c.name}\` = \`${c.value.slice(0, 50)}${c.value.length > 50 ? "..." : ""}\` (${c.domain})${flagStr}`);
			}

			if (Object.keys(session.raw.localStorage).length > 0) {
				parts.push("");
				parts.push(`**localStorage keys:** ${Object.keys(session.raw.localStorage).join(", ")}`);
			}

			// UI output: tab context + file path so the user knows where sensitive data is stored
			const originLabel = session.origin.replace("https://", "").replace("http://", "");
			const suffix = filePath ? ` → ${filePath}` : "";
			return {
				llmOutput: parts.join("\n"),
				uiOutput: `▸ Exporting session of "${originLabel}"${suffix}`,
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
