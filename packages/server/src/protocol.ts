// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
