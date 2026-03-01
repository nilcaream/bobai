// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; output: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean }
	| { type: "done"; sessionId: string; model: string }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
