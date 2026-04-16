import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, openWs, startTestServer, waitForWsMessage } from "./helpers";

const startedServers: Array<ReturnType<typeof startTestServer>> = [];
const openDbs: ReturnType<typeof createTestDb>[] = [];
const openSockets: WebSocket[] = [];

function trackServer(started: ReturnType<typeof startTestServer>) {
	startedServers.push(started);
	return started;
}

function trackSocket(ws: WebSocket) {
	openSockets.push(ws);
	return ws;
}

function trackDb(db: ReturnType<typeof createTestDb>) {
	openDbs.push(db);
	return db;
}

afterEach(() => {
	for (const ws of openSockets.splice(0)) {
		try {
			ws.close();
		} catch {
			// ignore cleanup errors
		}
	}
	for (const started of startedServers.splice(0)) {
		started.server.stop(true);
	}
	for (const db of openDbs.splice(0)) {
		db.close();
	}
});

describe("server WebSocket error branches", () => {
	test("invalid JSON produces an error message", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const ws = trackSocket(await openWs(started.wsUrl));
		const response = waitForWsMessage(ws, (message) => message.type === "error");

		ws.send('{"type":');

		expect(await response).toEqual({ type: "error", message: "Invalid JSON" });
	});

	test("unknown message type produces an error message", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const ws = trackSocket(await openWs(started.wsUrl));
		const response = waitForWsMessage(ws, (message) => message.type === "error");

		ws.send(JSON.stringify({ type: "mystery" }));

		expect(await response).toEqual({ type: "error", message: "Unknown message type: mystery" });
	});

	test("prompt without provider configuration returns an error", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const ws = trackSocket(await openWs(started.wsUrl));
		const response = waitForWsMessage(ws, (message) => message.type === "error");

		ws.send(JSON.stringify({ type: "prompt", text: "hello" }));

		expect(await response).toEqual({ type: "error", message: "No provider configured" });
	});

	test("cancel without an active prompt is a no-op and keeps the socket open", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const ws = trackSocket(await openWs(started.wsUrl));

		ws.send(JSON.stringify({ type: "cancel" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	test("cancel aborts an active prompt and still keeps the socket open", async () => {
		let aborted = false;
		const db = trackDb(createTestDb());
		const started = trackServer(
			startTestServer({
				port: 0,
				db,
				model: "test-model",
				provider: {
					id: "slow",
					async *stream(opts) {
						yield { type: "text", text: "working" };
						await new Promise<void>((resolve) => {
							opts.signal?.addEventListener("abort", () => {
								aborted = true;
								resolve();
							});
						});
					},
				},
			}),
		);
		const ws = trackSocket(await openWs(started.wsUrl));

		ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		ws.send(JSON.stringify({ type: "cancel" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(aborted).toBe(true);
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});
});
