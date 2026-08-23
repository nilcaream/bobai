import type { ServerMessage } from "./protocol";

export type Phase = "waiting" | "working" | "processing";

export type ProgressState =
	| { phase: "idle" }
	| { phase: "waiting"; startedAt: number }
	| { phase: "working"; startedAt: number; pendingToolCalls: number }
	| { phase: "processing"; startedAt: number; events: number };

export const IDLE: ProgressState = { phase: "idle" };

const VISIBILITY_DELAY_MS = 200;

/**
 * Pure event reducer. `now` is injected so tests stay deterministic.
 * Transitions follow the agent-loop event ordering: content deltas stream
 * first, then tool calls, then tool results.
 */
export function onEvent(state: ProgressState, event: ServerMessage, now: number): ProgressState {
	switch (event.type) {
		case "prompt_echo":
			return { phase: "waiting", startedAt: now };

		case "token":
		case "reasoning_token":
			if (state.phase === "processing") {
				return { ...state, events: state.events + 1 };
			}
			return { phase: "processing", startedAt: now, events: 1 };

		case "reasoning_start":
			if (state.phase === "processing") return state;
			return { phase: "processing", startedAt: now, events: 0 };

		case "tool_call":
			if (state.phase === "working") {
				return { ...state, pendingToolCalls: state.pendingToolCalls + 1 };
			}
			return { phase: "working", startedAt: now, pendingToolCalls: 1 };

		case "tool_result":
			if (state.phase === "working" && state.pendingToolCalls > 1) {
				return { ...state, pendingToolCalls: state.pendingToolCalls - 1 };
			}
			return { phase: "waiting", startedAt: now };

		case "done":
		case "error":
		case "subagent_done":
			return IDLE;

		default:
			return state;
	}
}

/**
 * Status-bar string, or null when idle / still under the 200ms visibility threshold.
 */
export function formatProgress(state: ProgressState, now: number): string | null {
	if (state.phase === "idle") return null;

	const elapsedMs = now - state.startedAt;
	if (elapsedMs < VISIBILITY_DELAY_MS) return null;
	const s = elapsedMs / 1000;

	if (state.phase === "waiting") return `Waiting ${s.toFixed(1)} s`;
	if (state.phase === "working") return `Working ${s.toFixed(1)} s`;
	return `Processing ${state.events} events`;
}
