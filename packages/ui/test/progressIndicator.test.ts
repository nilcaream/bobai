import { describe, expect, test } from "bun:test";
import { formatProgress, IDLE, onEvent, type ProgressState } from "../src/progressIndicator";
import type { ServerMessage } from "../src/protocol";

const T0 = 1_000_000;

function feed(state: ProgressState, events: ServerMessage[], now = T0): ProgressState {
	let s = state;
	for (const event of events) s = onEvent(s, event, now);
	return s;
}

describe("onEvent", () => {
	test("prompt_echo enters waiting", () => {
		expect(onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0)).toEqual({ phase: "waiting", startedAt: T0 });
	});

	test("first token enters processing and increments", () => {
		const waiting = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		const processing = onEvent(waiting, { type: "token", text: "a" }, T0);
		expect(processing).toEqual({ phase: "processing", startedAt: T0, events: 1 });
		expect(onEvent(processing, { type: "token", text: "b" }, T0)).toEqual({
			phase: "processing",
			startedAt: T0,
			events: 2,
		});
	});

	test("reasoning_start enters processing without counting", () => {
		const waiting = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		expect(onEvent(waiting, { type: "reasoning_start" }, T0)).toEqual({ phase: "processing", startedAt: T0, events: 0 });
	});

	test("reasoning tokens count toward events", () => {
		const s = feed(IDLE, [
			{ type: "prompt_echo", text: "hi" },
			{ type: "reasoning_start" },
			{ type: "reasoning_token", text: "think" },
			{ type: "reasoning_end" },
		]);
		expect(s).toEqual({ phase: "processing", startedAt: T0, events: 1 });
	});

	test("tool_call enters working and tracks pending tools", () => {
		const s = feed(
			IDLE,
			[
				{ type: "prompt_echo", text: "hi" },
				{ type: "token", text: "a" },
				{ type: "tool_call", id: "t1", output: "run", mergeable: false },
			],
			T0,
		);
		expect(s).toEqual({ phase: "working", startedAt: T0, pendingToolCalls: 1 });
		expect(onEvent(s, { type: "tool_call", id: "t2", output: "run", mergeable: false }, T0)).toEqual({
			phase: "working",
			startedAt: T0,
			pendingToolCalls: 2,
		});
	});

	test("tool_result keeps working until the last pending tool resolves", () => {
		let s = feed(
			IDLE,
			[
				{ type: "prompt_echo", text: "hi" },
				{ type: "tool_call", id: "t1", output: "run", mergeable: false },
				{ type: "tool_call", id: "t2", output: "run", mergeable: false },
			],
			T0,
		);
		s = onEvent(s, { type: "tool_result", id: "t1", output: null, mergeable: false }, T0 + 100);
		expect(s).toEqual({ phase: "working", startedAt: T0, pendingToolCalls: 1 });
		s = onEvent(s, { type: "tool_result", id: "t2", output: null, mergeable: false }, T0 + 200);
		expect(s).toEqual({ phase: "waiting", startedAt: T0 + 200 });
	});

	test("done, error, and subagent_done reset to idle", () => {
		const active = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		expect(onEvent(active, { type: "done", sessionId: "s", model: "m" }, T0)).toEqual(IDLE);
		expect(onEvent(active, { type: "error", message: "boom" }, T0)).toEqual(IDLE);
		expect(onEvent(active, { type: "subagent_done", sessionId: "c", model: "m" }, T0)).toEqual(IDLE);
	});

	test("irrelevant events are ignored", () => {
		const waiting = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		expect(onEvent(waiting, { type: "status", text: "usage" }, T0)).toEqual(waiting);
		expect(onEvent(waiting, { type: "session_subscribed", sessionId: "s" }, T0)).toEqual(waiting);
		expect(onEvent(waiting, { type: "subagent_start", sessionId: "c", title: "t", toolCallId: "x" }, T0)).toEqual(waiting);
	});
});

describe("formatProgress", () => {
	test("idle renders nothing", () => {
		expect(formatProgress(IDLE, T0)).toBeNull();
	});

	test("hides phases under the 200ms threshold", () => {
		const waiting = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		expect(formatProgress(waiting, T0 + 199)).toBeNull();
		expect(formatProgress(waiting, T0 + 200)).toBe("Waiting 0.2 s");
	});

	test("formats waiting with one decimal", () => {
		const waiting = onEvent(IDLE, { type: "prompt_echo", text: "hi" }, T0);
		expect(formatProgress(waiting, T0 + 42670)).toBe("Waiting 42.7 s");
	});

	test("formats working with one decimal", () => {
		const working = onEvent(IDLE, { type: "tool_call", id: "t1", output: "run", mergeable: false }, T0);
		expect(formatProgress(working, T0 + 41220)).toBe("Working 41.2 s");
	});

	test("formats processing with event count", () => {
		const s = feed(
			IDLE,
			[
				{ type: "prompt_echo", text: "hi" },
				{ type: "token", text: "a" },
				{ type: "token", text: "b" },
				{ type: "token", text: "c" },
			],
			T0,
		);
		expect(formatProgress(s, T0 + 1500)).toBe("Processing 3 events");
	});

	test("processing is also hidden under the 200ms threshold", () => {
		const processing = onEvent(IDLE, { type: "token", text: "a" }, T0);
		expect(formatProgress(processing, T0 + 199)).toBeNull();
		expect(formatProgress(processing, T0 + 200)).toBe("Processing 1 events");
	});
});
