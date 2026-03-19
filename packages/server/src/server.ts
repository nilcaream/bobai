import type { Database } from "bun:sqlite";
import path from "node:path";
import { type CommandRequest, handleCommand } from "./command";
import { handlePrompt } from "./handler";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import { CURATED_MODELS, formatModelCost, formatModelDisplay } from "./provider/copilot-models";
import type { Provider } from "./provider/provider";
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

			if (url.pathname === "/bobai/prompts/recent") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const limitParam = Number(url.searchParams.get("limit") ?? 10);
				const limit = Math.min(Math.max(1, Number.isFinite(limitParam) ? limitParam : 10), 50);
				const prompts = getRecentPrompts(options.db, limit);
				return Response.json(prompts);
			}

			// Context endpoint: GET /bobai/session/:id/context
			const contextMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/context$/);
			if (contextMatch) {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const messages = getMessages(options.db, decodeURIComponent(contextMatch[1]));
				return Response.json(messages);
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
