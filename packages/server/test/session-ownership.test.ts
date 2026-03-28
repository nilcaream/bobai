import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerMessage } from "../src/protocol";
import { createServer } from "../src/server";
import { createSession } from "../src/session/repository";
import { createTestDb } from "./helpers";

/**
 * Helper: open a WebSocket, wait for it to be connected, return it.
 */
function openWs(wsUrl: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

/**
 * Helper: send a JSON message and wait for the first response that matches a predicate.
 */
function sendAndWait(
	ws: WebSocket,
	msg: object,
	predicate: (m: ServerMessage) => boolean,
	timeoutMs = 2000,
): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
		const handler = (event: MessageEvent) => {
			const parsed = JSON.parse(event.data as string) as ServerMessage;
			if (predicate(parsed)) {
				clearTimeout(timer);
				ws.removeEventListener("message", handler);
				resolve(parsed);
			}
		};
		ws.addEventListener("message", handler);
		ws.send(JSON.stringify(msg));
	});
}

/**
 * Helper: wait for a message matching predicate (without sending anything).
 */
function waitForMessage(
	ws: WebSocket,
	predicate: (m: ServerMessage) => boolean,
	timeoutMs = 2000,
): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
		const handler = (event: MessageEvent) => {
			const parsed = JSON.parse(event.data as string) as ServerMessage;
			if (predicate(parsed)) {
				clearTimeout(timer);
				ws.removeEventListener("message", handler);
				resolve(parsed);
			}
		};
		ws.addEventListener("message", handler);
	});
}

describe("Session Ownership", () => {
	let server: ReturnType<typeof Bun.serve>;
	let wsUrl: string;
	let baseUrl: string;
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
		server = createServer({ port: 0, db });
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
	});

	test("first subscriber gets session_subscribed", async () => {
		const session = createSession(db);
		const ws = await openWs(wsUrl);
		try {
			const reply = await sendAndWait(
				ws,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_subscribed", sessionId: session.id });
		} finally {
			ws.close();
		}
	});

	test("second subscriber gets session_locked", async () => {
		const session = createSession(db);
		const ws1 = await openWs(wsUrl);
		const ws2 = await openWs(wsUrl);
		try {
			// First subscriber takes ownership
			await sendAndWait(
				ws1,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed",
			);

			// Second subscriber is rejected
			const reply = await sendAndWait(
				ws2,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_locked", sessionId: session.id });
		} finally {
			ws1.close();
			ws2.close();
		}
	});

	test("ownership released on ws close — new subscriber succeeds", async () => {
		const session = createSession(db);
		const ws1 = await openWs(wsUrl);

		// First subscriber takes ownership
		await sendAndWait(
			ws1,
			{ type: "subscribe", sessionId: session.id },
			(m) => m.type === "session_subscribed",
		);

		// Close ws1 to release ownership
		ws1.close();
		// Give the server a moment to process the close event
		await new Promise((r) => setTimeout(r, 100));

		// Now ws2 should be able to subscribe
		const ws2 = await openWs(wsUrl);
		try {
			const reply = await sendAndWait(
				ws2,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_subscribed", sessionId: session.id });
		} finally {
			ws2.close();
		}
	});

	test("subscribing to a new session releases previous ownership", async () => {
		const session1 = createSession(db);
		const session2 = createSession(db);
		const ws1 = await openWs(wsUrl);
		const ws2 = await openWs(wsUrl);

		try {
			// ws1 subscribes to session1
			await sendAndWait(
				ws1,
				{ type: "subscribe", sessionId: session1.id },
				(m) => m.type === "session_subscribed",
			);

			// ws1 subscribes to session2 — should release session1
			await sendAndWait(
				ws1,
				{ type: "subscribe", sessionId: session2.id },
				(m) => m.type === "session_subscribed",
			);

			// ws2 should now be able to subscribe to session1
			const reply = await sendAndWait(
				ws2,
				{ type: "subscribe", sessionId: session1.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_subscribed", sessionId: session1.id });
		} finally {
			ws1.close();
			ws2.close();
		}
	});

	test("unsubscribe releases ownership", async () => {
		const session = createSession(db);
		const ws1 = await openWs(wsUrl);
		const ws2 = await openWs(wsUrl);

		try {
			// ws1 subscribes
			await sendAndWait(
				ws1,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed",
			);

			// ws1 unsubscribes — no response expected, so just send and wait a tick
			ws1.send(JSON.stringify({ type: "unsubscribe" }));
			await new Promise((r) => setTimeout(r, 100));

			// ws2 should now succeed
			const reply = await sendAndWait(
				ws2,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_subscribed", sessionId: session.id });
		} finally {
			ws1.close();
			ws2.close();
		}
	});

	test("HTTP ownership endpoint returns owned: false for unowned session", async () => {
		const session = createSession(db);
		const res = await fetch(`${baseUrl}/bobai/session/${session.id}/ownership`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ owned: false });
	});

	test("HTTP ownership endpoint returns owned: true for owned session", async () => {
		const session = createSession(db);
		const ws = await openWs(wsUrl);
		try {
			await sendAndWait(
				ws,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed",
			);

			const res = await fetch(`${baseUrl}/bobai/session/${session.id}/ownership`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ owned: true });
		} finally {
			ws.close();
		}
	});

	test("sessions list includes owned field", async () => {
		// Create a fresh server+db to avoid interference from other tests
		const freshDb = createTestDb();
		const freshServer = createServer({ port: 0, db: freshDb });
		const freshWsUrl = `ws://localhost:${freshServer.port}/bobai/ws`;
		const freshBaseUrl = `http://localhost:${freshServer.port}`;

		try {
			const s1 = createSession(freshDb);
			const s2 = createSession(freshDb);

			// Subscribe to s1 only
			const ws = await openWs(freshWsUrl);
			await sendAndWait(
				ws,
				{ type: "subscribe", sessionId: s1.id },
				(m) => m.type === "session_subscribed",
			);

			const res = await fetch(`${freshBaseUrl}/bobai/sessions`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{ id: string; owned: boolean }>;

			const entry1 = body.find((e) => e.id === s1.id);
			const entry2 = body.find((e) => e.id === s2.id);

			expect(entry1?.owned).toBe(true);
			expect(entry2?.owned).toBe(false);

			ws.close();
		} finally {
			freshServer.stop(true);
			freshDb.close();
		}
	});

	test("same ws re-subscribing to same session succeeds", async () => {
		const session = createSession(db);
		const ws = await openWs(wsUrl);
		try {
			// Subscribe once
			await sendAndWait(
				ws,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed",
			);

			// Subscribe again — same ws, same session — should succeed, not lock
			const reply = await sendAndWait(
				ws,
				{ type: "subscribe", sessionId: session.id },
				(m) => m.type === "session_subscribed" || m.type === "session_locked",
			);
			expect(reply).toEqual({ type: "session_subscribed", sessionId: session.id });
		} finally {
			ws.close();
		}
	});
});
