import type { Database } from "bun:sqlite";
import path from "node:path";
import { type CommandRequest, handleCommand } from "./command";
import { compactMessagesWithStats } from "./compaction/engine";
import { createCompactionRegistry } from "./compaction/registry";
import { handlePrompt } from "./handler";
import type { Logger } from "./log/logger";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import { CURATED_MODELS, formatModelCost, formatModelDisplay, loadModelsConfig } from "./provider/copilot-models";
import type { AssistantMessage, Provider } from "./provider/provider";
import {
	getMessages,
	getMostRecentParentSession,
	getRecentPrompts,
	getSession,
	listSessions,
	listSubagentSessions,
} from "./session/repository";
import type { SkillRegistry } from "./skill/skill";

export interface ServerOptions {
	port: number;
	staticDir?: string;
	db?: Database;
	provider?: Provider;
	model?: string;
	projectRoot?: string;
	configDir?: string;
	skills?: SkillRegistry;
	skillDirectories?: string[];
	logger?: Logger;
	logDir?: string;
}

export function createServer(options: ServerOptions) {
	const staticDir = options.staticDir;

	return Bun.serve({
		port: options.port,
		async fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/bobai/ws") {
				const upgraded = server.upgrade(req);
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bobai/health") {
				return Response.json({ status: "ok" });
			}

			// GET /bobai/skills — list available skills
			if (url.pathname === "/bobai/skills") {
				const skillList = options.skills?.list() ?? [];
				return Response.json(skillList.map((s) => ({ name: s.name, description: s.description })));
			}

			// POST /bobai/skill — get skill content by name
			if (url.pathname === "/bobai/skill" && req.method === "POST") {
				const body = (await req.json()) as { name: string };
				const skill = options.skills?.get(body.name);
				if (!skill) {
					return new Response("Skill not found", { status: 404 });
				}
				return Response.json({ name: skill.name, description: skill.description, content: skill.content });
			}

			if (url.pathname === "/bobai/prompts/recent") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const limitParam = Number(url.searchParams.get("limit") ?? 10);
				const limit = Math.min(Math.max(1, Number.isFinite(limitParam) ? limitParam : 10), 50);
				const prompts = getRecentPrompts(options.db, limit);
				return Response.json(prompts);
			}

			// Context endpoint: GET /bobai/session/:id/context[?compacted=true]
			const contextMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/context$/);
			if (contextMatch) {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessionId = decodeURIComponent(contextMatch[1]);
				const storedMessages = getMessages(options.db, sessionId);

				if (url.searchParams.get("compacted") !== "true") {
					return Response.json(storedMessages);
				}

				// Compacted view: convert to Message[], run compaction, return with stats
				const session = getSession(options.db, sessionId);
				const promptTokens = session?.promptTokens ?? 0;
				const modelId = session?.model ?? options.model ?? "";
				const modelConfigs = loadModelsConfig();
				const modelConfig = modelConfigs.find((m) => m.id === modelId);
				const contextWindow = modelConfig?.contextWindow ?? 0;

				const messages = storedMessages.map((m) => {
					if (m.role === "tool" && m.metadata?.tool_call_id) {
						return { role: "tool" as const, content: m.content, tool_call_id: m.metadata.tool_call_id as string };
					}
					if (m.role === "assistant" && m.metadata?.tool_calls) {
						return {
							role: "assistant" as const,
							content: m.content || null,
							tool_calls: m.metadata.tool_calls as AssistantMessage["tool_calls"],
						};
					}
					return { role: m.role as "system" | "user" | "assistant", content: m.content };
				});

				if (contextWindow <= 0 || promptTokens <= 0) {
					return Response.json({ messages: storedMessages, stats: null, reason: "no context pressure data" });
				}

				const tools = createCompactionRegistry();
				const { messages: compacted, stats } = compactMessagesWithStats({
					messages,
					context: { promptTokens, contextWindow },
					tools,
				});

				// Convert compacted Message[] back to a StoredMessage-like shape for the UI
				const compactedStored = compacted.map((m, i) => {
					if (m.role === "tool") {
						const toolMsg = m as { role: "tool"; content: string; tool_call_id: string };
						// Find original stored message to preserve metadata
						const original = storedMessages.find((s) => s.role === "tool" && s.metadata?.tool_call_id === toolMsg.tool_call_id);
						return {
							...(original ?? { id: `compacted-${i}`, role: "tool", createdAt: "" }),
							content: toolMsg.content,
							metadata: { ...original?.metadata, tool_call_id: toolMsg.tool_call_id },
						};
					}
					return (
						storedMessages[i] ?? {
							id: `msg-${i}`,
							role: m.role,
							content: (m as { content: string }).content ?? "",
							createdAt: "",
							metadata: null,
						}
					);
				});

				return Response.json({ messages: compactedStored, stats });
			}

			if (url.pathname === "/bobai/models") {
				const models = CURATED_MODELS.map((id, i) => ({
					index: i + 1,
					id,
					cost: formatModelCost(id),
				}));
				const defaultModel = options.model ?? "gpt-5-mini";
				const defaultStatus = formatModelDisplay(defaultModel, 0, options.configDir);
				return Response.json({ models, defaultModel, defaultStatus });
			}

			if (url.pathname === "/bobai/command" && req.method === "POST") {
				if (!options.db) {
					return Response.json({ ok: false, error: "Database not available" });
				}
				const body = (await req.json()) as CommandRequest;
				const result = handleCommand(options.db, body, options.configDir);
				return Response.json(result);
			}

			if (url.pathname === "/bobai/subagents") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const parentId = url.searchParams.get("parentId");
				if (!parentId) {
					return Response.json({ error: "parentId is required" }, { status: 400 });
				}
				const subagents = listSubagentSessions(options.db, parentId);
				const body = subagents.map((s, i) => ({
					index: i + 1,
					title: s.title ?? "(untitled)",
					sessionId: s.id,
				}));
				return Response.json(body);
			}

			// GET /bobai/sessions/recent — most recently updated parent session
			if (url.pathname === "/bobai/sessions/recent") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const session = getMostRecentParentSession(options.db);
				if (!session) return Response.json(null);
				const status = session.model ? formatModelDisplay(session.model, session.promptTokens, options.configDir) : null;
				return Response.json({ id: session.id, title: session.title, model: session.model, status });
			}

			// GET /bobai/sessions — list parent sessions
			if (url.pathname === "/bobai/sessions") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessions = listSessions(options.db, 9);
				const body = sessions.map((s, i) => ({
					index: i + 1,
					id: s.id,
					title: s.title,
					updatedAt: s.updatedAt,
				}));
				return Response.json(body);
			}

			// GET /bobai/session/:id/load — session metadata + messages
			const loadMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/load$/);
			if (loadMatch) {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessionId = decodeURIComponent(loadMatch[1]);
				const session = getSession(options.db, sessionId);
				if (!session) {
					return new Response("Session not found", { status: 404 });
				}
				const messages = getMessages(options.db, sessionId);
				const status = session.model ? formatModelDisplay(session.model, session.promptTokens, options.configDir) : null;
				return Response.json({
					session: { id: session.id, title: session.title, model: session.model, parentId: session.parentId },
					messages,
					status,
				});
			}

			if (staticDir && url.pathname.startsWith("/bobai")) {
				const relative = url.pathname.replace(/^\/bobai\/?/, "");
				const filePath = path.join(staticDir, relative || "index.html");
				const file = Bun.file(filePath);
				return file.exists().then((exists) => {
					if (exists) return new Response(file);
					return new Response("Not Found", { status: 404 });
				});
			}

			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				let msg: ClientMessage;
				try {
					msg = JSON.parse(raw as string) as ClientMessage;
				} catch {
					send(ws, { type: "error", message: "Invalid JSON" });
					return;
				}

				if (msg.type === "prompt") {
					if (options.provider && options.model && options.db) {
						handlePrompt({
							ws,
							db: options.db,
							provider: options.provider,
							model: options.model,
							text: msg.text,
							sessionId: msg.sessionId,
							projectRoot: options.projectRoot ?? process.cwd(),
							skills: options.skills ?? { get: () => undefined, list: () => [] },
							skillDirectories: options.skillDirectories,
							stagedSkills: msg.stagedSkills,
							logger: options.logger,
							logDir: options.logDir,
						}).catch((err) => {
							send(ws, { type: "error", message: "Unexpected error" });
							console.error("Unhandled error in handlePrompt:", err);
						});
					} else {
						send(ws, { type: "error", message: "No provider configured" });
					}
					return;
				}

				send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
			},
		},
	});
}
