import type { Database } from "bun:sqlite";
import { formatMemoryAge, memoryFreshnessCaveat, memorySummary } from "../memory/index";
import {
	createMemory,
	deleteMemory,
	findMemoryByTitle,
	getMemory,
	isMemoryType,
	listMemories,
	type Memory,
	type MemoryType,
	searchMemories,
	updateMemory,
} from "../memory/repository";
import type { Tool, ToolContext, ToolResult } from "./tool";

/** Base distance for memory tool compaction factor calculation. */
export const MEMORY_BASE_DISTANCE = 150;

/** Max entries returned by `list`. */
const MAX_LIST_RESULTS = 50;
/** Max entries returned by `search`. */
const MAX_SEARCH_RESULTS = 20;

const WRITE_COMMANDS = ["save", "update", "delete"] as const;
const READ_COMMANDS = ["list", "search", "get"] as const;
type Command = (typeof READ_COMMANDS)[number] | (typeof WRITE_COMMANDS)[number];

const READ_ONLY_ERROR =
	"Error: memories are read-only in subagent context. If you discovered something worth remembering, " +
	"report it in your final response so the main agent can decide whether to save it.";

export interface MemoryToolOptions {
	/** When true, only read commands are exposed and writes are rejected. */
	readOnly?: boolean;
}

function errorResult(message: string): ToolResult {
	return { llmOutput: message, uiOutput: message, mergeable: true };
}

function formatEntry(memory: Memory): string {
	const summary = memorySummary(memory);
	const desc = summary ? ` — ${summary}` : "";
	return `- \`${memory.id}\` [${memory.type}] ${memory.title}${desc} (${formatMemoryAge(memory.updatedAt)})`;
}

/** Resolve a memory id by exact match or unique prefix (>= 4 chars). */
function resolveMemory(db: Database, id: string): { memory: Memory } | { error: string } {
	const exact = getMemory(db, id);
	if (exact) return { memory: exact };

	if (id.length >= 4) {
		const matches = listMemories(db).filter((m) => m.id.startsWith(id));
		if (matches.length === 1 && matches[0]) return { memory: matches[0] };
		if (matches.length > 1) {
			return { error: `Error: id "${id}" is ambiguous — it matches ${matches.length} memories. Use a longer id or \`list\`. ` };
		}
	}

	return { error: `Error: no memory found with id "${id}". Use \`list\` to see available memories.` };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() : undefined;
}

export function createMemoryTool(db: Database, options?: MemoryToolOptions): Tool {
	const readOnly = options?.readOnly ?? false;
	const commands: readonly Command[] = readOnly ? READ_COMMANDS : [...READ_COMMANDS, ...WRITE_COMMANDS];

	const description = readOnly
		? "Read project memories saved in previous sessions. Commands: list, search, get. Memories are read-only for subagents — if you discover something worth remembering, report it in your final response so the main agent can save it."
		: "Store and retrieve project memories that persist across sessions. Use when you learn something worth remembering about this project — user preferences, corrections, non-obvious decisions, gotchas, or external references. Commands: list, search, get, save, update, delete. `save` creates a memory or updates an existing one with the same title.";

	return {
		definition: {
			type: "function",
			function: {
				name: "memory",
				description,
				parameters: {
					type: "object",
					properties: {
						command: {
							type: "string",
							enum: [...commands],
							description: "The memory command to run",
						},
						id: {
							type: "string",
							description: "Memory id (full id or unique prefix) for get, update, or delete",
						},
						query: {
							type: "string",
							description: "Search text for the search command",
						},
						type: {
							type: "string",
							enum: ["user", "feedback", "project", "reference"],
							description: "Memory type for save (or to filter list)",
						},
						title: {
							type: "string",
							description: "Short label for the memory (save or update)",
						},
						description: {
							type: "string",
							description: "One-line summary shown in memory listings (save or update)",
						},
						content: {
							type: "string",
							description: "Full memory text (save or update)",
						},
					},
					required: ["command"],
				},
			},
		},
		mergeable: true,
		baseDistance: MEMORY_BASE_DISTANCE,

		formatCall(args: Record<string, unknown>): string {
			const command = typeof args.command === "string" ? args.command : "memory";
			if (command === "save" || command === "update") {
				const id = typeof args.id === "string" ? args.id : undefined;
				const title = typeof args.title === "string" ? args.title : undefined;
				const target = command === "save" ? (title ?? "?") : (id ?? "?");
				return `▸ memory ${command} "${target}"`;
			}
			if (command === "get" || command === "delete") {
				const id = typeof args.id === "string" ? args.id : "?";
				return `▸ memory ${command} ${id}`;
			}
			if (command === "search") {
				const query = typeof args.query === "string" ? args.query : "?";
				return `▸ memory search "${query}"`;
			}
			return `▸ memory ${command}`;
		},

		async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
			const command = typeof args.command === "string" ? args.command : "";

			if (!commands.includes(command as Command)) {
				if (readOnly && WRITE_COMMANDS.includes(command as (typeof WRITE_COMMANDS)[number])) {
					return errorResult(READ_ONLY_ERROR);
				}
				const valid = commands.join(", ");
				return errorResult(`Error: unknown or unavailable command "${command}". Available commands: ${valid}`);
			}

			switch (command) {
				case "list": {
					const type = typeof args.type === "string" ? args.type : undefined;
					if (type !== undefined && !isMemoryType(type)) {
						return errorResult(`Error: invalid type "${type}". Valid types: user, feedback, project, reference.`);
					}
					const memories = listMemories(db, type ? { type } : undefined);
					if (memories.length === 0) {
						return errorResult(type ? `No "${type}" memories saved yet.` : "No memories saved yet.");
					}
					const shown = memories.slice(0, MAX_LIST_RESULTS);
					const hidden = memories.length - shown.length;
					const header = type ? `Memories (type: ${type}, ${memories.length}):` : `Memories (${memories.length}):`;
					const body = shown.map(formatEntry).join("\n");
					const note = hidden > 0 ? `\n(… ${hidden} more — use \`search\` to narrow down)` : "";
					return {
						llmOutput: `${header}\n${body}${note}`,
						uiOutput: null,
						mergeable: true,
					};
				}

				case "search": {
					const query = asString(args.query);
					if (!query) {
						return errorResult("Error: 'query' parameter is required for search.");
					}
					const memories = searchMemories(db, query, MAX_SEARCH_RESULTS);
					if (memories.length === 0) {
						return errorResult(`No memories match "${query}".`);
					}
					const body = memories.map(formatEntry).join("\n");
					return {
						llmOutput: `Matches for "${query}" (${memories.length}):\n${body}`,
						uiOutput: null,
						mergeable: true,
					};
				}

				case "get": {
					const id = asString(args.id);
					if (!id) {
						return errorResult("Error: 'id' parameter is required for get.");
					}
					const resolved = resolveMemory(db, id);
					if ("error" in resolved) return errorResult(resolved.error);
					const memory = resolved.memory;
					const caveat = memoryFreshnessCaveat(memory.updatedAt);
					const parts = [
						`# ${memory.title}`,
						"",
						`Type: ${memory.type}`,
						memory.description ? `Summary: ${memory.description}` : null,
						`Updated: ${formatMemoryAge(memory.updatedAt)} (${memory.updatedAt})`,
						"",
						memory.content,
					].filter((p): p is string => p !== null);
					const prefix = caveat ? `> ${caveat}\n\n` : "";
					return {
						llmOutput: `${prefix}${parts.join("\n")}`,
						uiOutput: null,
						mergeable: true,
					};
				}

				case "save": {
					if (readOnly) return errorResult(READ_ONLY_ERROR);
					const type = typeof args.type === "string" ? args.type : undefined;
					const title = asString(args.title);
					const content = asString(args.content);
					const description = asString(args.description) || undefined;

					if (!isMemoryType(type)) {
						return errorResult("Error: 'type' must be one of: user, feedback, project, reference.");
					}
					if (!title) {
						return errorResult("Error: 'title' is required and must be a non-empty string.");
					}
					if (!content) {
						return errorResult("Error: 'content' is required and must be a non-empty string.");
					}

					const existing = findMemoryByTitle(db, title);
					if (existing) {
						const updated = updateMemory(db, existing.id, {
							type: type as MemoryType,
							title,
							content,
							...(description !== undefined ? { description } : {}),
						});
						const id = updated?.id ?? existing.id;
						return {
							llmOutput: `Updated existing memory \`${id}\` ("${title}").`,
							uiOutput: `▸ Updated memory "${title}"`,
							mergeable: true,
						};
					}

					const created = createMemory(db, {
						type: type as MemoryType,
						title,
						content,
						description,
						sessionId: ctx.sessionId,
					});
					return {
						llmOutput: `Saved memory \`${created.id}\` ("${title}").`,
						uiOutput: `▸ Saved memory "${title}"`,
						mergeable: true,
					};
				}

				case "update": {
					if (readOnly) return errorResult(READ_ONLY_ERROR);
					const id = asString(args.id);
					if (!id) {
						return errorResult("Error: 'id' parameter is required for update.");
					}
					const resolved = resolveMemory(db, id);
					if ("error" in resolved) return errorResult(resolved.error);

					const patch: {
						type?: MemoryType;
						title?: string;
						description?: string | null;
						content?: string;
					} = {};

					if (args.type !== undefined) {
						if (!isMemoryType(args.type)) {
							return errorResult("Error: 'type' must be one of: user, feedback, project, reference.");
						}
						patch.type = args.type;
					}
					if (args.title !== undefined) {
						const title = asString(args.title);
						if (!title) return errorResult("Error: 'title' must be a non-empty string.");
						patch.title = title;
					}
					if (args.description !== undefined) {
						const description = asString(args.description);
						patch.description = description || null;
					}
					if (args.content !== undefined) {
						const content = asString(args.content);
						if (!content) return errorResult("Error: 'content' must be a non-empty string.");
						patch.content = content;
					}

					if (Object.keys(patch).length === 0) {
						return errorResult("Error: provide at least one field to update (type, title, description, or content).");
					}

					const updated = updateMemory(db, resolved.memory.id, patch);
					if (!updated) return errorResult(`Error: no memory found with id "${resolved.memory.id}".`);
					return {
						llmOutput: `Updated memory \`${updated.id}\` ("${updated.title}").`,
						uiOutput: `▸ Updated memory "${updated.title}"`,
						mergeable: true,
					};
				}

				case "delete": {
					if (readOnly) return errorResult(READ_ONLY_ERROR);
					const id = asString(args.id);
					if (!id) {
						return errorResult("Error: 'id' parameter is required for delete.");
					}
					const resolved = resolveMemory(db, id);
					if ("error" in resolved) return errorResult(resolved.error);
					const memory = resolved.memory;
					deleteMemory(db, memory.id);
					return {
						llmOutput: `Deleted memory \`${memory.id}\` ("${memory.title}").`,
						uiOutput: `▸ Deleted memory "${memory.title}"`,
						mergeable: true,
					};
				}

				default:
					return errorResult(`Error: unknown command "${command}".`);
			}
		},
	};
}
