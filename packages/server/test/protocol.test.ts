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
});
