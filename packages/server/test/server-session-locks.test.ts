import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createSession } from "../src/session/repository";
import { createTestDb, openWs, startTestServer, waitForWsMessage } from "./helpers";

const startedServers: Array<ReturnType<typeof startTestServer>> = [];
const openDbs: Database[] = [];
const openSockets: WebSocket[] = [];

function trackServer(started: ReturnType<typeof startTestServer>) {
	startedServers.push(started);
	return started;
}

function trackDb(db: Database) {
	openDbs.push(db);
	return db;
}

function trackSocket(ws: WebSocket) {
	openSockets.push(ws);
	return ws;
}

function createBlockingProvider() {
	let active = 0;
	let peakActive = 0;
	const starts: Array<{ sessionId?: string; activeAtStart: number }> = [];
	const resolvers: Array<() => void> = [];

	const provider: Provider = {
		id: "blocking",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			active++;
			peakActive = Math.max(peakActive, active);
			starts.push({ sessionId: opts.metadata?.sessionId, activeAtStart: active });
			yield { type: "text", text: `start-${starts.length}` };
			await new Promise<void>((resolve) => {
				resolvers.push(resolve);
			});
			yield { type: "text", text: `finish-${starts.length}` };
			yield { type: "finish", reason: "stop" };
			active--;
		},
	};

	return {
		provider,
		starts,
		getPeakActive: () => peakActive,
		releaseOne() {
			const resolve = resolvers.shift();
			if (!resolve) throw new Error("No blocked provider call to release");
			resolve();
		},
	};
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

describe("server session locks", () => {
	test("prompts for the same existing session are serialized", async () => {
		const db = trackDb(createTestDb());
		const session = createSession(db);
		const blocking = createBlockingProvider();
		const started = trackServer(startTestServer({ port: 0, db, provider: blocking.provider, model: "test-model" }));
		const ws = trackSocket(await openWs(started.wsUrl));

		ws.send(JSON.stringify({ type: "prompt", text: "first", sessionId: session.id }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		ws.send(JSON.stringify({ type: "prompt", text: "second", sessionId: session.id }));
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(blocking.starts).toHaveLength(1);
		expect(blocking.getPeakActive()).toBe(1);

		const firstDone = waitForWsMessage(ws, (message) => message.type === "done" && message.sessionId === session.id);
		blocking.releaseOne();
		await firstDone;
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(blocking.starts).toHaveLength(2);
		expect(blocking.getPeakActive()).toBe(1);

		const secondDone = waitForWsMessage(ws, (message) => message.type === "done" && message.sessionId === session.id);
		blocking.releaseOne();
		await secondDone;
	});

	test("prompts without session IDs can run concurrently", async () => {
		const db = trackDb(createTestDb());
		const blocking = createBlockingProvider();
		const started = trackServer(startTestServer({ port: 0, db, provider: blocking.provider, model: "test-model" }));
		const ws1 = trackSocket(await openWs(started.wsUrl));
		const ws2 = trackSocket(await openWs(started.wsUrl));

		ws1.send(JSON.stringify({ type: "prompt", text: "first new session" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		ws2.send(JSON.stringify({ type: "prompt", text: "second new session" }));
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(blocking.starts).toHaveLength(2);
		expect(blocking.getPeakActive()).toBe(2);
		expect(blocking.starts[0].activeAtStart).toBe(1);
		expect(blocking.starts[1].activeAtStart).toBe(2);

		const done1 = waitForWsMessage(ws1, (message) => message.type === "done");
		const done2 = waitForWsMessage(ws2, (message) => message.type === "done");
		blocking.releaseOne();
		blocking.releaseOne();
		await done1;
		await done2;
	});

	test("lock cleanup allows a later prompt on the same session after earlier prompts finish", async () => {
		const db = trackDb(createTestDb());
		const session = createSession(db);
		const blocking = createBlockingProvider();
		const started = trackServer(startTestServer({ port: 0, db, provider: blocking.provider, model: "test-model" }));
		const ws = trackSocket(await openWs(started.wsUrl));

		ws.send(JSON.stringify({ type: "prompt", text: "first", sessionId: session.id }));
		const firstDone = waitForWsMessage(ws, (message) => message.type === "done" && message.sessionId === session.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		blocking.releaseOne();
		await firstDone;

		ws.send(JSON.stringify({ type: "prompt", text: "second", sessionId: session.id }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(blocking.starts).toHaveLength(2);
		expect(blocking.getPeakActive()).toBe(1);

		const secondDone = waitForWsMessage(ws, (message) => message.type === "done" && message.sessionId === session.id);
		blocking.releaseOne();
		await secondDone;
	});
});
