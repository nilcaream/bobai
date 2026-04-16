import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { DbGuard } from "../src/db-guard";
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

const connectedGuard: DbGuard = {
	assertConnected() {},
	isConnected() {
		return true;
	},
};

describe("server HTTP error branches", () => {
	test("GET /bobai/subagents returns 503 when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/subagents?parentId=parent-1`);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Database not available");
	});

	test("GET /bobai/subagents returns 400 when parentId is missing", async () => {
		const db = trackDb(createTestDb());
		const started = trackServer(startTestServer({ port: 0, db }));
		const res = await fetch(`${started.baseUrl}/bobai/subagents`);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "parentId is required" });
	});

	test("GET /bobai/sessions returns 503 when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/sessions`);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Database not available");
	});

	test("GET /bobai/sessions/recent returns 503 when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/sessions/recent`);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Database not available");
	});

	test("GET /bobai/session/:id/load returns 503 when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/session/test-session/load`);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Database not available");
	});

	test("POST /bobai/command returns Database not available when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: "irrelevant", sessionId: "missing" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Database not available" });
	});

	test("DELETE /bobai/session/:id returns Database not available when db is not configured", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/session/missing`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Database not available" });
	});

	test("plain HTTP GET /bobai/ws returns 400 with upgrade failure message", async () => {
		const started = trackServer(startTestServer({ port: 0 }));
		const res = await fetch(`${started.baseUrl}/bobai/ws`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("WebSocket upgrade failed");
	});

	test("DELETE /bobai/session/:id returns Session not found when dbGuard succeeds but the session does not exist", async () => {
		const db = trackDb(createTestDb());
		const started = trackServer(startTestServer({ port: 0, db, dbGuard: connectedGuard }));
		const res = await fetch(`${started.baseUrl}/bobai/session/missing`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Session not found" });
	});

	test("DELETE /bobai/session/:id returns error when the session is active in another tab", async () => {
		const db = trackDb(createTestDb());
		const started = trackServer(startTestServer({ port: 0, db }));
		const session = createSession(db);
		const ws = trackSocket(await openWs(started.wsUrl));
		ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }));
		await waitForWsMessage(ws, (message) => message.type === "session_subscribed");

		const res = await fetch(`${started.baseUrl}/bobai/session/${session.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Session is active in another tab" });
	});
});
