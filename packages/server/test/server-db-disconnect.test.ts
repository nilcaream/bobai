import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DbDisconnectedError, type DbGuard } from "../src/db-guard";
import type { Logger } from "../src/log/logger";
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

function disconnectedGuard(dbPath = "/fake/bobai.db"): DbGuard {
	return {
		assertConnected() {
			throw new DbDisconnectedError(dbPath);
		},
		isConnected() {
			return false;
		},
	};
}

function toggleableGuard(dbPath = "/fake/bobai.db"): DbGuard & { disconnect: () => void } {
	let disconnected = false;
	return {
		assertConnected() {
			if (disconnected) throw new DbDisconnectedError(dbPath);
		},
		isConnected() {
			return !disconnected;
		},
		disconnect() {
			disconnected = true;
		},
	};
}

function recordingLogger(): { logger: Logger; errors: string[] } {
	const errors: string[] = [];
	const logger: Logger = {
		level: "debug",
		logDir: ".",
		debug() {},
		info() {},
		warn() {},
		error(_system, message) {
			errors.push(message);
		},
		withScope() {
			return logger;
		},
	};
	return { logger, errors };
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

describe("server DB disconnect handling", () => {
	test("POST /bobai/command returns Database disconnected and logs the disconnect", async () => {
		const db = trackDb(createTestDb());
		const { logger, errors } = recordingLogger();
		const started = trackServer(startTestServer({ port: 0, db, dbGuard: disconnectedGuard(), logger }));
		const session = createSession(db);

		const res = await fetch(`${started.baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: "New Title", sessionId: session.id }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Database disconnected" });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Database disconnected:");
	});

	test("DELETE /bobai/session/:id returns Database disconnected when dbGuard trips", async () => {
		const db = trackDb(createTestDb());
		const started = trackServer(startTestServer({ port: 0, db, dbGuard: disconnectedGuard() }));
		const session = createSession(db);

		const res = await fetch(`${started.baseUrl}/bobai/session/${session.id}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "Database disconnected" });
	});

	test("DB disconnect is broadcast to all connected WebSockets when triggered by HTTP command", async () => {
		const db = trackDb(createTestDb());
		const started = trackServer(startTestServer({ port: 0, db, dbGuard: disconnectedGuard() }));
		const session = createSession(db);
		const ws1 = trackSocket(await openWs(started.wsUrl));
		const ws2 = trackSocket(await openWs(started.wsUrl));

		const msg1 = waitForWsMessage(ws1, (message) => message.type === "db_disconnected");
		const msg2 = waitForWsMessage(ws2, (message) => message.type === "db_disconnected");

		await fetch(`${started.baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: "New Title", sessionId: session.id }),
		});

		expect(await msg1).toEqual({ type: "db_disconnected" });
		expect(await msg2).toEqual({ type: "db_disconnected" });
	});

	test("DB disconnect aborts an in-flight prompt before broadcasting", async () => {
		let aborted = false;
		const guard = toggleableGuard();
		const db = trackDb(createTestDb());
		const session = createSession(db);
		const started = trackServer(
			startTestServer({
				port: 0,
				db,
				model: "test-model",
				dbGuard: guard,
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
		const dbDisconnected = waitForWsMessage(ws, (message) => message.type === "db_disconnected");

		ws.send(JSON.stringify({ type: "prompt", text: "hello", sessionId: session.id }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		guard.disconnect();
		await fetch(`${started.baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: "New Title", sessionId: session.id }),
		});

		expect(await dbDisconnected).toEqual({ type: "db_disconnected" });
		expect(aborted).toBe(true);
	});
});
