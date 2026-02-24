export interface ServerOptions {
	port: number;
}

export function createServer(options: ServerOptions) {
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

			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				ws.send(message);
			},
		},
	});
}
