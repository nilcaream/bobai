import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";
import { getMessages } from "../src/session/repository";

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

function mockProvider(tokens: string[]): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions) {
			for (const t of tokens) yield t;
		},
	};
}

/** Provider that captures the messages it received */
function capturingProvider(tokens: string[]): Provider & { captured: ProviderOptions[] } {
	const captured: ProviderOptions[] = [];
	return {
		id: "mock",
		captured,
		async *stream(opts: ProviderOptions) {
			captured.push(opts);
			for (const t of tokens) yield t;
		},
	};
}

function failingProvider(status: number, body: string): Provider {
	return {
		id: "mock",
		stream() {
			async function* gen(): AsyncGenerator<string> {
				yield* [];
				throw new ProviderError(status, body);
			}
			return gen();
		},
	};
}

describe("handlePrompt", () => {
	let db: Database;

	beforeAll(() => {
		db = initTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("creates new session when no sessionId provided", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi" });

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.sessionId).toBeTruthy();
	});

	test("streams tokens then done with sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi" });

		const msgs = ws.messages();
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " world" },
		]);
		expect(msgs.at(-1).type).toBe("done");
		expect(msgs.at(-1).sessionId).toBeTruthy();
	});

	test("persists user and assistant messages to DB", async () => {
		const ws = mockWs();
		const provider = mockProvider(["response text"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "my question" });

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		expect(stored).toHaveLength(3); // system + user + assistant
		expect(stored[0].role).toBe("system");
		expect(stored[1].role).toBe("user");
		expect(stored[1].content).toBe("my question");
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].content).toBe("response text");
	});

	test("resumes existing session with sessionId", async () => {
		const ws1 = mockWs();
		const provider1 = mockProvider(["first response"]);
		await handlePrompt({ ws: ws1, db, provider: provider1, model: "test-model", text: "first" });
		const sessionId = ws1.messages().find((m: { type: string }) => m.type === "done").sessionId;

		const ws2 = mockWs();
		const provider2 = capturingProvider(["second response"]);
		await handlePrompt({ ws: ws2, db, provider: provider2, model: "test-model", text: "second", sessionId });

		// Provider should have received full history
		const sentMessages = provider2.captured[0].messages;
		expect(sentMessages).toHaveLength(4); // system + user1 + assistant1 + user2
		expect(sentMessages[0].role).toBe("system");
		expect(sentMessages[1].content).toBe("first");
		expect(sentMessages[2].content).toBe("first response");
		expect(sentMessages[3].content).toBe("second");

		// DB should have 5 messages total
		const stored = getMessages(db, sessionId);
		expect(stored).toHaveLength(5); // system + user1 + assistant1 + user2 + assistant2
	});

	test("sends error for unknown sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["x"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", sessionId: "nonexistent" });

		const msgs = ws.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("not found");
	});

	test("sends error on ProviderError", async () => {
		const ws = mockWs();
		const provider = failingProvider(401, "Unauthorized");
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi" });

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("401");
	});
});
