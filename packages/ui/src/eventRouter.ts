import type { RouteResult, ServerMessage } from "./protocol";

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

			// prompt_echo without sessionId — always parent (user's own prompts)
			if (msg.type === "prompt_echo" && !("sessionId" in msg && msg.sessionId)) {
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
