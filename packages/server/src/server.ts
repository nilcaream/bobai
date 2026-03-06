import type { Database } from "bun:sqlite";
import path from "node:path";
import { type CommandRequest, handleCommand } from "./command";
import { handlePrompt } from "./handler";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import { CURATED_MODELS, formatModelCost, formatModelDisplay } from "./provider/copilot-models";
import type { Provider } from "./provider/provider";
import { getMessages, getRecentPrompts, listSubagentSessions } from "./session/repository";

export interface ServerOptions {
	port: number;
	staticDir?: string;
	db?: Database;
	provider?: Provider;
	model?: string;
	projectRoot?: string;
	configDir?: string;
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
				const messages = getMessages(options.db, contextMatch[1]);
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
				const subagents = listSubagentSessions(options.db);
				const body = subagents.map((s, i) => ({
					index: i + 1,
					title: s.title ?? "(untitled)",
					sessionId: s.id,
				}));
				return Response.json(body);
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
