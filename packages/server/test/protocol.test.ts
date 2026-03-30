import { describe, expect, test } from "bun:test";
import { send } from "../src/protocol";

function mockWs() {
	const sent: string[] = [];
	return {
		send(msg: string) {
			sent.push(msg);
		},
		messages() {
			return sent.map((s) => JSON.parse(s));
		},
	};
}

describe("protocol", () => {
	test("send done includes sessionId", () => {
		const ws = mockWs();
		send(ws, { type: "done", sessionId: "abc-123", model: "claude-sonnet" });
		expect(ws.messages()[0]).toEqual({ type: "done", sessionId: "abc-123", model: "claude-sonnet" });
	});

	test("send token message unchanged", () => {
		const ws = mockWs();
		send(ws, { type: "token", text: "hello" });
		expect(ws.messages()[0]).toEqual({ type: "token", text: "hello" });
	});

	test("send encodes tool_call message", () => {
		const ws = mockWs();
		send(ws, { type: "tool_call", id: "call_1", output: "**Reading** `src/index.ts`" });
		expect(ws.messages()[0]).toEqual({
			type: "tool_call",
			id: "call_1",
			output: "**Reading** `src/index.ts`",
		});
	});

	test("send encodes tool_result message", () => {
		const ws = mockWs();
		send(ws, { type: "tool_result", id: "call_1", output: "file contents", mergeable: true });
		expect(ws.messages()[0]).toEqual({
			type: "tool_result",
			id: "call_1",
			output: "file contents",
			mergeable: true,
		});
	});

	test("send encodes tool_result with null output", () => {
		const ws = mockWs();
		send(ws, { type: "tool_result", id: "call_1", output: null, mergeable: false });
		expect(ws.messages()[0]).toEqual({
			type: "tool_result",
			id: "call_1",
			output: null,
			mergeable: false,
		});
	});

	test("send token with sessionId includes it in output", () => {
		const ws = mockWs();
		send(ws, { type: "token", text: "hello", sessionId: "child-1" });
		expect(ws.messages()[0]).toEqual({ type: "token", text: "hello", sessionId: "child-1" });
	});

	test("send subagent_start message", () => {
		const ws = mockWs();
		send(ws, { type: "subagent_start", sessionId: "child-1", title: "Exploring code", toolCallId: "call_1" });
		expect(ws.messages()[0]).toEqual({
			type: "subagent_start",
			sessionId: "child-1",
			title: "Exploring code",
			toolCallId: "call_1",
		});
	});

	test("send subagent_done message", () => {
		const ws = mockWs();
		send(ws, { type: "subagent_done", sessionId: "child-1" });
		expect(ws.messages()[0]).toEqual({ type: "subagent_done", sessionId: "child-1" });
	});
});
