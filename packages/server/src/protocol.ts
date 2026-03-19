// Client → Server
export type ClientMessage = {
	type: "prompt";
	text: string;
	sessionId?: string;
	stagedSkills?: { name: string; content: string }[];
};

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; summary?: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "subagent_start"; sessionId: string; title: string }
	| { type: "subagent_done"; sessionId: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
