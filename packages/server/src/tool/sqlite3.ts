import { Database } from "bun:sqlite";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool } from "./tool";
import { isPathAccessible, type ToolContext, type ToolResult } from "./tool";

const MAX_OUTPUT_BYTES = 32_000;

/** SQL keywords that indicate a read-only query returning rows. */
const READ_PREFIXES = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];

/** Strip leading SQL comments (single-line and block) and whitespace. */
function stripLeadingComments(sql: string): string {
	let s = sql;
	while (true) {
		s = s.trimStart();
		if (s.startsWith("--")) {
			const eol = s.indexOf("\n");
			s = eol === -1 ? "" : s.slice(eol + 1);
		} else if (s.startsWith("/*")) {
			const end = s.indexOf("*/");
			s = end === -1 ? "" : s.slice(end + 2);
		} else {
			break;
		}
	}
	return s;
}

function isReadQuery(sql: string): boolean {
	const stripped = stripLeadingComments(sql).toUpperCase();
	return READ_PREFIXES.some((prefix) => stripped.startsWith(prefix));
}

/**
 * Format an array of row objects as a Markdown-style table.
 * Returns "(empty result set)" when rows is empty.
 */
function formatTable(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) return "(empty result set)";

	const columns = Object.keys(rows[0]);
	const header = `| ${columns.join(" | ")} |`;
	const separator = `| ${columns.map(() => "---").join(" | ")} |`;
	const body = rows.map((row) => `| ${columns.map((col) => sanitizeCell(row[col])).join(" | ")} |`).join("\n");

	return `${header}\n${separator}\n${body}`;
}

/** Make a cell value safe for a single-line GFM table row with no markdown formatting. */
function sanitizeCell(value: unknown): string {
	const str = String(value ?? "NULL");
	return str
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\n/g, " ")
		.replace(/[*_`~[\]#>]/g, (ch) => `\\${ch}`);
}

/** Truncate output keeping the tail (most recent/relevant output). */
function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	const kept = text.slice(-MAX_OUTPUT_BYTES);
	return `... truncated (${text.length} bytes total, showing last ${MAX_OUTPUT_BYTES})\n${kept}`;
}

export const sqlite3Tool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "sqlite3",
			description:
				"Execute a SQL query against a SQLite database in the project directory. Returns query results as a formatted table for SELECT/PRAGMA/EXPLAIN/WITH queries, or a summary of changes for write operations (INSERT, UPDATE, DELETE, CREATE, etc.). The database file is created automatically if it does not exist.",
			parameters: {
				type: "object",
				properties: {
					database: {
						type: "string",
						description: "Path to the SQLite database file, relative to the project root",
					},
					query: {
						type: "string",
						description: "SQL query to execute",
					},
				},
				required: ["database", "query"],
			},
		},
	},

	mergeable: false,

	outputThreshold: 0.4,

	compact(output: string, callArgs: Record<string, unknown>): string {
		const database = typeof callArgs.database === "string" ? callArgs.database : "?";
		const query = typeof callArgs.query === "string" ? callArgs.query : "?";
		if (output.startsWith("Error")) return output;

		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 20) return output;

		// Keep first 10 lines (header + early rows) and last 10 lines
		const head = lines.slice(0, 10).join("\n");
		const tail = lines.slice(-10).join("\n");
		const removed = total - 20;
		return `${COMPACTION_MARKER} ${removed} rows from sqlite3(${JSON.stringify({ database, query })}) omitted\n${head}\n...\n${tail}`;
	},

	formatCall(args: Record<string, unknown>): string {
		const database = typeof args.database === "string" ? args.database : "?";
		const query = typeof args.query === "string" ? args.query : "?";
		return formatScript(database, query);
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const database = args.database;
		if (typeof database !== "string" || database.length === 0) {
			return {
				llmOutput: "Error: 'database' argument is required and must be a non-empty string",
				uiOutput: "Error: 'database' argument is required and must be a non-empty string",
				mergeable: false,
			};
		}

		const query = args.query;
		if (typeof query !== "string" || query.length === 0) {
			return {
				llmOutput: "Error: 'query' argument is required and must be a non-empty string",
				uiOutput: "Error: 'query' argument is required and must be a non-empty string",
				mergeable: false,
			};
		}

		const resolved = path.resolve(ctx.projectRoot, database);
		if (!isPathAccessible(resolved, ctx)) {
			return {
				llmOutput: `Error: path "${database}" is outside the project root`,
				uiOutput: `Error: path "${database}" is outside the project root`,
				mergeable: false,
			};
		}

		let db: Database | undefined;
		const startTime = performance.now();
		try {
			db = new Database(resolved, { create: true });
			db.exec("PRAGMA journal_mode = WAL");

			if (isReadQuery(query)) {
				const rows = db.prepare(query).all() as Record<string, unknown>[];
				const elapsed = (performance.now() - startTime) / 1000;
				const table = formatTable(rows);
				const output = truncate(table);
				const rowCount = rows.length;
				return {
					llmOutput: output,
					uiOutput: formatUiOutput(database, query, rowCount > 0 ? output : null),
					mergeable: false,
					summary: formatSummary(`rows: ${rowCount}`, elapsed),
				};
			}

			db.run(query);
			const changes = db.query("SELECT changes() as count").get() as { count: number };
			const elapsed = (performance.now() - startTime) / 1000;
			return {
				llmOutput: `Query executed successfully. Rows affected: ${changes.count}`,
				uiOutput: formatUiOutput(database, query, null),
				mergeable: false,
				summary: formatSummary(`rows affected: ${changes.count}`, elapsed),
			};
		} catch (err) {
			const elapsed = (performance.now() - startTime) / 1000;
			const errorMsg = (err as Error).message;
			return {
				llmOutput: `Error: ${errorMsg}`,
				uiOutput: formatUiOutput(database, query, null),
				mergeable: false,
				summary: formatSummary(errorMsg, elapsed),
			};
		} finally {
			db?.close();
		}
	},
};

/** Render the header as inline code (used in formatCall). */
function formatHeader(database: string): string {
	return `\`sqlite3 ${database}\``;
}

/** Render header + horizontal rule + query as a fenced SQL code block (script section). */
function formatScript(database: string, query: string): string {
	return `${formatHeader(database)}\n\n---\n\n\`\`\`sql\n${query}\n\`\`\``;
}

/** Build the full UI output: script section + result. */
function formatUiOutput(database: string, query: string, output: string | null): string {
	if (output === null) return formatScript(database, query);
	return `${formatScript(database, query)}\n\n${output}`;
}

/** Build the summary line: "YYYY-MM-DD HH:MM:SS | rows: N | 1.23s" */
function formatSummary(status: string, elapsedSec: number): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${ts} | ${status} | ${elapsedSec.toFixed(2)}s`;
}
