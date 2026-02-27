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
		send(ws, { type: "done", sessionId: "abc-123" });
		expect(ws.messages()[0]).toEqual({ type: "done", sessionId: "abc-123" });
	});

	test("send token message unchanged", () => {
		const ws = mockWs();
		send(ws, { type: "token", text: "hello" });
		expect(ws.messages()[0]).toEqual({ type: "token", text: "hello" });
	});

	test("send encodes tool_call message", () => {
		const ws = mockWs();
		send(ws, { type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "src/index.ts" } });
		expect(ws.messages()[0]).toEqual({
			type: "tool_call",
			id: "call_1",
			name: "read_file",
			arguments: { path: "src/index.ts" },
		});
	});

	test("send encodes tool_result message", () => {
		const ws = mockWs();
		send(ws, { type: "tool_result", id: "call_1", name: "read_file", output: "file contents" });
		expect(ws.messages()[0]).toEqual({
			type: "tool_result",
			id: "call_1",
			name: "read_file",
			output: "file contents",
		});
	});

	test("send encodes tool_result with isError", () => {
		const ws = mockWs();
		send(ws, { type: "tool_result", id: "call_1", name: "read_file", output: "not found", isError: true });
		expect(ws.messages()[0]).toEqual({
			type: "tool_result",
			id: "call_1",
			name: "read_file",
			output: "not found",
			isError: true,
		});
	});
});
