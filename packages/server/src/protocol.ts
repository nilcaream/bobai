// Client → Server
export type ClientMessage = { type: "prompt"; text: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "done" }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
