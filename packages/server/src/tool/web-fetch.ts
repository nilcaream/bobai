import TurndownService from "turndown";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 2000;

type Format = "markdown" | "text" | "html";

const ACCEPT_HEADERS: Record<Format, string> = {
	markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
	text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
	html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
};

function htmlToMarkdown(html: string): string {
	const td = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	td.remove(["script", "style", "meta", "link", "noscript"]);
	return td.turndown(html);
}

async function htmlToText(html: string): Promise<string> {
	let text = "";
	let skipDepth = 0;
	const skipTags = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);
	const skipSelector = Array.from(skipTags).join(", ");
	const rewriter = new HTMLRewriter()
		.on(skipSelector, {
			element(el) {
				skipDepth++;
				el.onEndTag(() => {
					skipDepth--;
				});
			},
		})
		.on("*", {
			text(t) {
				if (skipDepth === 0) text += t.text;
			},
		});
	await rewriter.transform(new Response(html)).text();
	return text.trim();
}

function truncateOutput(text: string): string {
	const lines = text.split("\n");
	let chars = 0;
	let cutLine = lines.length;
	for (let i = 0; i < lines.length; i++) {
		chars += lines[i].length + 1;
		if (i >= MAX_OUTPUT_LINES || chars > MAX_OUTPUT_CHARS) {
			cutLine = i;
			break;
		}
	}
	if (cutLine >= lines.length) return text;
	const kept = lines.slice(0, cutLine).join("\n");
	const dropped = lines.length - cutLine;
	return `${kept}\n\n... ${dropped} lines truncated (total: ${lines.length} lines, ${text.length} bytes)`;
}

function isMarkdownContentType(ct: string): boolean {
	return ct.includes("text/markdown") || ct.includes("text/x-markdown");
}

function isHtmlContentType(ct: string): boolean {
	return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

function formatSummary(status: string, elapsedSec: number): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${ts} | ${status} | ${elapsedSec.toFixed(2)}s`;
}

export const webFetchTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "web_fetch",
			description:
				"Fetch a web page or URL and return its content as markdown, plain text, or raw HTML. Uses content negotiation to prefer the most token-efficient format. Useful for reading documentation, API references, or any publicly accessible web content.",
			parameters: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "The URL to fetch. Must start with http:// or https://",
					},
					format: {
						type: "string",
						enum: ["markdown", "text", "html"],
						description: 'Output format. Defaults to "markdown".',
					},
					timeout: {
						type: "number",
						description: "Timeout in seconds. Defaults to 30, max 120.",
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
		const format = typeof args.format === "string" ? args.format : "markdown";
		return `▸ Fetching ${escapeMarkdown(url)} (${format})`;
	},

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		if (lines.length <= 20) return output;
		const url = typeof callArgs.url === "string" ? callArgs.url : "?";
		const head = lines.slice(0, 15).join("\n");
		return `${COMPACTION_MARKER} web_fetch(${url}) — showing first 15 of ${lines.length} lines\n${head}`;
	},

	async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
		const url = typeof args.url === "string" ? args.url : "";
		const format = (typeof args.format === "string" ? args.format : "markdown") as Format;
		const timeoutParam = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_MS / 1000;

		// Validate URL scheme
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			return {
				llmOutput: "Error: URL must start with http:// or https://",
				uiOutput: "Error: URL must start with http:// or https://",
				mergeable: false,
			};
		}

		// Clamp timeout
		const timeoutMs = Math.max(1000, Math.min(timeoutParam * 1000, MAX_TIMEOUT_MS));

		// Build headers
		const accept = ACCEPT_HEADERS[format] ?? ACCEPT_HEADERS.markdown;
		const headers: Record<string, string> = {
			"User-Agent": "BobAI/1.0",
			Accept: accept,
			"Accept-Language": "en-US,en;q=0.9",
		};

		const startTime = performance.now();

		try {
			const response = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (!response.ok) {
				const elapsed = (performance.now() - startTime) / 1000;
				const msg = `Error: HTTP ${response.status} ${response.statusText}`;
				return {
					llmOutput: msg,
					uiOutput: msg,
					mergeable: false,
					summary: formatSummary(`HTTP ${response.status}`, elapsed),
				};
			}

			// Check Content-Length header
			const contentLength = response.headers.get("content-length");
			if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
				const elapsed = (performance.now() - startTime) / 1000;
				const msg = `Error: Response too large (Content-Length: ${contentLength} bytes, max: ${MAX_RESPONSE_BYTES} bytes)`;
				return {
					llmOutput: msg,
					uiOutput: msg,
					mergeable: false,
					summary: formatSummary("too large", elapsed),
				};
			}

			// Read body
			const buf = await response.arrayBuffer();
			if (buf.byteLength > MAX_RESPONSE_BYTES) {
				const elapsed = (performance.now() - startTime) / 1000;
				const msg = `Error: Response too large (${buf.byteLength} bytes, max: ${MAX_RESPONSE_BYTES} bytes)`;
				return {
					llmOutput: msg,
					uiOutput: msg,
					mergeable: false,
					summary: formatSummary("too large", elapsed),
				};
			}

			const elapsed = (performance.now() - startTime) / 1000;
			const raw = new TextDecoder().decode(buf);
			const contentType = response.headers.get("content-type") ?? "";

			// Convert based on format and content type
			let content: string;
			if (isMarkdownContentType(contentType)) {
				// Response is already markdown — use as-is
				content = raw;
			} else if (format === "markdown" && isHtmlContentType(contentType)) {
				content = htmlToMarkdown(raw);
			} else if (format === "text" && isHtmlContentType(contentType)) {
				content = await htmlToText(raw);
			} else if (format === "html") {
				content = raw;
			} else {
				// Plain text or unknown — use as-is
				content = raw;
			}

			const truncated = truncateOutput(content);
			const bytesLabel = `${buf.byteLength} bytes`;

			return {
				llmOutput: truncated,
				uiOutput: `**${escapeMarkdown(url)}**\n\n---\n\n${truncated}`,
				mergeable: false,
				summary: formatSummary(bytesLabel, elapsed),
			};
		} catch (err) {
			const elapsed = (performance.now() - startTime) / 1000;
			const msg = `Error: ${(err as Error).message}`;
			return {
				llmOutput: msg,
				uiOutput: msg,
				mergeable: false,
				summary: formatSummary("error", elapsed),
			};
		}
	},
};

export { htmlToMarkdown, htmlToText, truncateOutput };
