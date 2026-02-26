import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Provider } from "../src/provider/provider";
import { createServer } from "../src/server";

function initTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			sort_order INTEGER NOT NULL
		)
	`);
	db.exec("CREATE INDEX idx_messages_session ON messages(session_id, sort_order)");
	return db;
}

type AnyMsg = Record<string, unknown> & { type: string };

function sendAndCollect(wsUrl: string, msg: Record<string, unknown>): Promise<AnyMsg[]> {
	return new Promise((resolve, reject) => {
		const msgs: AnyMsg[] = [];
		const ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			ws.send(JSON.stringify(msg));
		};
		ws.onmessage = (event) => {
			const parsed = JSON.parse(event.data as string) as AnyMsg;
			msgs.push(parsed);
			if (parsed.type === "done" || parsed.type === "error") {
				ws.close();
			}
		};
		ws.onclose = () => resolve(msgs);
		ws.onerror = (err) => reject(err);
	});
}

describe("prompt session", () => {
	let server: ReturnType<typeof Bun.serve>;
	let wsUrl: string;

	beforeAll(() => {
		const db = initTestDb();
		const provider: Provider = {
			id: "test",
			async *stream() {
				yield "test ";
				yield "response";
			},
		};
		server = createServer({ port: 0, db, provider, model: "test-model" });
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("streams token messages then done in response to a prompt", async () => {
		const received: string[] = [];
		const ws = new WebSocket(wsUrl);

		const done = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
			};
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string) as { type: string; text?: string };
				received.push(msg.type);
				if (msg.type === "done") {
					ws.close();
				}
			};
			ws.onclose = () => resolve();
			ws.onerror = (err) => reject(err);
		});

		await done;

		expect(received.length).toBeGreaterThan(1);
		expect(received.at(-1)).toBe("done");
		expect(received.slice(0, -1).every((t) => t === "token")).toBe(true);
	});

	test("sends error message for unknown message type", async () => {
		const received: { type: string; message?: string }[] = [];
		const ws = new WebSocket(wsUrl);

		const done = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "unknown" }));
			};
			ws.onmessage = (event) => {
				received.push(JSON.parse(event.data as string));
				ws.close();
			};
			ws.onclose = () => resolve();
			ws.onerror = (err) => reject(err);
		});

		await done;

		expect(received[0]?.type).toBe("error");
	});

	test("second prompt with sessionId resumes session", async () => {
		const msgs1 = await sendAndCollect(wsUrl, { type: "prompt", text: "first" });
		const sessionId = msgs1.find((m) => m.type === "done")!.sessionId;

		const msgs2 = await sendAndCollect(wsUrl, { type: "prompt", text: "second", sessionId });
		const done2 = msgs2.find((m) => m.type === "done");
		expect(done2!.sessionId).toBe(sessionId);
	});

	test("prompt with invalid sessionId returns error", async () => {
		const msgs = await sendAndCollect(wsUrl, { type: "prompt", text: "hi", sessionId: "bad-id" });
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("not found");
	});
});
