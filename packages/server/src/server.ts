import path from "node:path";
import { handlePrompt } from "./handler";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";

export interface ServerOptions {
	port: number;
	staticDir?: string;
}

export function createServer(options: ServerOptions) {
	const staticDir = options.staticDir;

	return Bun.serve({
		port: options.port,
		fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/bobai/ws") {
				const upgraded = server.upgrade(req);
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bobai/health") {
				return Response.json({ status: "ok" });
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
					handlePrompt(ws, msg);
					return;
				}

				send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
			},
		},
	});
}
