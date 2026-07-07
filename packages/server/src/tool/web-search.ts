import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

const DEFAULT_TIMEOUT_S = 15;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 60;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

interface TavilySearchParams {
	query: string;
	max_results: number;
	include_answer?: "basic" | false;
	search_depth?: "basic" | "advanced";
	include_raw_content?: false | "markdown";
	include_images?: boolean;
	include_domains?: string[];
}

interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score: number;
	raw_content: string | null;
}

interface TavilyResponse {
	query: string;
	answer: string | null;
	images: string[];
	results: TavilyResult[];
	response_time: number;
}

function formatSummaryLine(status: string, elapsedSec: number): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${ts} | ${status} | ${elapsedSec.toFixed(2)}s`;
}

function searchesDir(ctx: ToolContext): string {
	return join(ctx.projectRoot, ".bobai", "searches", ctx.sessionId, ctx.toolCallId ?? "unknown");
}

function resultPath(ctx: ToolContext, index: number): string {
	return `.bobai/searches/${ctx.sessionId}/${ctx.toolCallId}/${index}.md`;
}

async function saveRawContent(ctx: ToolContext, index: number, content: string): Promise<void> {
	const dir = searchesDir(ctx);
	await Bun.write(join(dir, `${index}.md`), content);
}

function buildLlmOutput(
	query: string,
	results: TavilyResult[],
	answer: string | null,
	images: string[],
	elapsedSec: number,
	savedIndices: number[],
	fullPagesRequested: boolean,
	ctx: ToolContext,
): string {
	const lines: string[] = [];
	lines.push(`## Web Search Results for "${query}" — ${results.length} results in ${elapsedSec.toFixed(1)}s`);
	lines.push("");

	if (answer) {
		lines.push(`**Summary:** ${answer}`);
		lines.push("");
	}

	// Results table
	lines.push("| # | Title | Relevance |");
	lines.push("|---|-------|-----------|");
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const title = (r.title || "Untitled").replace(/\|/g, "\\|");
		const pct = Math.round(r.score * 100);
		lines.push(`| ${i + 1} | ${title} | ${pct}% |`);
	}
	lines.push("");

	// Snippets with file paths
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`**${i + 1}.** ${r.title || "Untitled"} — ${r.url || "no-url"}`);
		if (r.content) {
			const snippet = r.content.length > 500 ? `${r.content.slice(0, 500)}...` : r.content;
			lines.push(`  ${snippet}`);
		}
		if (r.raw_content && ctx.toolCallId) {
			lines.push(`  📄 Full content saved to \`${resultPath(ctx, i)}\` — use \`read_file\` to read`);
		}
		lines.push("");
	}

	if (savedIndices.length > 0 && ctx.toolCallId) {
		lines.push("---");
		if (savedIndices.length === 1) {
			lines.push(`Full page content saved. Read with: \`read_file(path="${resultPath(ctx, savedIndices[0])}")\``);
		} else {
			lines.push(`${savedIndices.length} full pages saved. Read with:`);
			for (const idx of savedIndices) {
				lines.push(`- \`read_file(path="${resultPath(ctx, idx)}")\` (result ${idx + 1})`);
			}
		}
		lines.push("");
	} else if (fullPagesRequested && ctx.toolCallId) {
		lines.push("---");
		lines.push(
			"Full page content was requested but none of the results returned raw content. Try a different query or a single-result search for better coverage.",
		);
		lines.push("");
	}

	if (images.length > 0) {
		lines.push("## Images");
		lines.push("");
		for (const img of images) {
			lines.push(`- ${img}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function buildUiOutput(query: string, results: TavilyResult[], answer: string | null, images: string[]): string {
	const lines: string[] = [];

	lines.push(escapeMarkdown(query));
	lines.push("");
	lines.push("---");
	lines.push("");

	if (answer) {
		lines.push(`**Summary:** ${answer}`);
		lines.push("");
	}

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const escapedTitle = escapeMarkdown(r.title ?? "Untitled");
		lines.push(`${i + 1}. [${escapedTitle}](${r.url ?? ""})`);
	}

	if (images.length > 0) {
		lines.push("");
		lines.push("**Images:**");
		for (const img of images) {
			const escapedUrl = escapeMarkdown(img);
			lines.push(`- [${escapedUrl}](${img})`);
		}
	}

	return lines.join("\n");
}

export function createWebSearchTool(apiKey: string | undefined, fetchFn?: typeof fetch): Tool {
	const runFetch = fetchFn ?? fetch;

	return {
		definition: {
			type: "function" as const,
			function: {
				name: "web_search",
				description:
					"Search the web for information, documentation, or images. Returns relevant pages with snippets. Use `fullPages` to save complete page content to disk for later reading with `read_file`. Requires a configured web search provider (set up with `bobai auth tavily`).",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "The search query." },
						maxResults: {
							type: "number",
							description: `Maximum number of results to return (1–${MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
						},
						includeSummary: {
							type: "boolean",
							description: "Include an LLM-generated summary of the results. Defaults to false.",
						},
						advanced: {
							type: "boolean",
							description: "Use deeper, richer content extraction. Slower but more detailed snippets. Defaults to false.",
						},
						fullPages: {
							type: "boolean",
							description:
								"Save the full content of each result page as a markdown file in .bobai/searches/. Use `read_file` to read individual pages. Significantly slower. Defaults to false.",
						},
						includeImages: {
							type: "boolean",
							description: "Include image URLs in the results. Defaults to false.",
						},
						domains: {
							type: "array",
							items: { type: "string" },
							description: "Restrict search results to these domains (e.g., ['bun.sh', 'docs.rs']).",
						},
						timeout: {
							type: "number",
							description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
						},
					},
					required: ["query"],
				},
			},
		},

		mergeable: false,
		baseDistance: 200,
		outputThreshold: 0.3,

		formatCall(args: Record<string, unknown>): string {
			const query = typeof args.query === "string" ? args.query : "?";
			return `▸ Searching: ${escapeMarkdown(query)}`;
		},

		compact(output: string, _callArgs: Record<string, unknown>): string {
			const lines = output.split("\n");
			const header = lines.find((l) => l.startsWith("## Web Search Results"));
			if (header) return `Web search results (compacted). ${header}`;
			return output;
		},

		async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
			if (!apiKey) {
				return {
					llmOutput: "Error: No web search provider configured. Add a Tavily API key with: `bobai auth tavily`",
					uiOutput: "Error: No web search provider configured. Run `bobai auth tavily` to set up.",
					mergeable: false,
				};
			}

			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (!query) {
				return {
					llmOutput: "Error: A non-empty query string is required.",
					uiOutput: "Error: query is required.",
					mergeable: false,
				};
			}

			const maxResults =
				typeof args.maxResults === "number" ? Math.max(1, Math.min(args.maxResults, MAX_RESULTS)) : DEFAULT_MAX_RESULTS;

			const includeSummary = args.includeSummary === true;
			const advanced = args.advanced === true;
			const fullPages = args.fullPages === true;
			const includeImages = args.includeImages === true;
			const domains = Array.isArray(args.domains)
				? args.domains.filter((d: unknown): d is string => typeof d === "string")
				: undefined;

			const timeoutParam = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_S;
			const timeoutMs = Math.max(MIN_TIMEOUT_S * 1000, Math.min(timeoutParam * 1000, MAX_TIMEOUT_S * 1000));

			const tavilyParams: TavilySearchParams = { query, max_results: maxResults };
			if (includeSummary) tavilyParams.include_answer = "basic";
			if (advanced) tavilyParams.search_depth = "advanced";
			if (fullPages) tavilyParams.include_raw_content = "markdown";
			if (includeImages) tavilyParams.include_images = true;
			if (domains && domains.length > 0) tavilyParams.include_domains = domains;

			const startTime = performance.now();

			try {
				const response = await runFetch("https://api.tavily.com/search", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(tavilyParams),
					signal: ctx.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal]) : AbortSignal.timeout(timeoutMs),
				});

				const elapsed = (performance.now() - startTime) / 1000;

				if (!response.ok) {
					const body = await response.text().catch(() => response.statusText);
					return {
						llmOutput: `Error: Tavily search failed — ${response.status} ${body}`,
						uiOutput: `Error: HTTP ${response.status}`,
						mergeable: false,
						summary: formatSummaryLine(`${response.status} ${response.statusText}`, elapsed),
					};
				}

				const data = (await response.json()) as TavilyResponse;

				const savedIndices: number[] = [];
				if (fullPages && ctx.toolCallId) {
					for (let i = 0; i < data.results.length; i++) {
						const raw = data.results[i].raw_content;
						if (raw) {
							await saveRawContent(ctx, i, raw);
							savedIndices.push(i);
						}
					}
				}

				return {
					llmOutput: buildLlmOutput(
						query,
						data.results,
						data.answer,
						data.images ?? [],
						data.response_time ?? elapsed,
						savedIndices,
						fullPages,
						ctx,
					),
					uiOutput: buildUiOutput(query, data.results, data.answer, data.images ?? []),
					mergeable: false,
					summary: formatSummaryLine(`${data.results.length} results`, data.response_time ?? elapsed),
				};
			} catch (err) {
				const elapsed = (performance.now() - startTime) / 1000;
				return {
					llmOutput: `Error: ${(err as Error).message}`,
					uiOutput: `Error: ${(err as Error).message}`,
					mergeable: false,
					summary: formatSummaryLine("error", elapsed),
				};
			}
		},
	};
}
