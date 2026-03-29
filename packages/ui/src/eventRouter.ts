export type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; summary?: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "prompt_echo"; text: string }
	| { type: "subagent_start"; sessionId: string; title: string; toolCallId: string }
	| { type: "subagent_done"; sessionId: string }
	| { type: "session_created"; sessionId: string }
	| { type: "session_subscribed"; sessionId: string }
	| { type: "session_locked"; sessionId: string };

export type RouteResult =
	| { target: "parent"; msg: ServerMessage }
	| { target: "child"; sessionId: string }
	| { target: "lifecycle"; msg: ServerMessage };

export function createEventRouter() {
	const buffers = new Map<string, ServerMessage[]>();

	return {
		route(msg: ServerMessage): RouteResult {
			// Lifecycle events (subagent start/done) handled separately
			if (msg.type === "subagent_start" || msg.type === "subagent_done") {
				return { target: "lifecycle", msg };
			}

			// Session management events always go to parent
			if (msg.type === "session_created" || msg.type === "session_subscribed" || msg.type === "session_locked") {
				return { target: "parent", msg };
			}

			// prompt_echo has no sessionId concept — always parent
			if (msg.type === "prompt_echo") {
				return { target: "parent", msg };
			}

			// done always routes to parent (parent's done carries parent sessionId)
			if (msg.type === "done") {
				return { target: "parent", msg };
			}

			// Child events: has a truthy sessionId field
			if ("sessionId" in msg && msg.sessionId) {
				const sid = msg.sessionId as string;
				if (!buffers.has(sid)) buffers.set(sid, []);
				buffers.get(sid)?.push(msg);
				return { target: "child", sessionId: sid };
			}

			// Everything else → parent
			return { target: "parent", msg };
		},

		getBuffer(sessionId: string): ServerMessage[] {
			return buffers.get(sessionId) ?? [];
		},

		clearBuffer(sessionId: string) {
			buffers.delete(sessionId);
		},

		clearAllBuffers() {
			buffers.clear();
		},
	};
}
