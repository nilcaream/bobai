import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";
import { getMessages } from "../src/session/repository";
import { createTestDb } from "./helpers";

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
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

/** Provider that captures the messages it received */
function capturingProvider(tokens: string[]): Provider & { captured: ProviderOptions[] } {
	const captured: ProviderOptions[] = [];
	return {
		id: "mock",
		captured,
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			captured.push(opts);
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

function failingProvider(status: number, body: string): Provider {
	return {
		id: "mock",
		stream() {
			async function* gen(): AsyncGenerator<StreamEvent> {
				yield* [];
				throw new ProviderError(status, body);
			}
			return gen();
		},
	};
}

/** Provider that yields some tokens then throws a ProviderError */
function partialFailingProvider(tokens: string[], status: number, body: string): Provider {
	return {
		id: "mock",
		stream() {
			async function* gen(): AsyncGenerator<StreamEvent> {
				for (const t of tokens) yield { type: "text", text: t };
				throw new ProviderError(status, body);
			}
			return gen();
		},
	};
}

describe("handlePrompt", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
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

	test("persists partial response when provider errors mid-stream", async () => {
		const ws = mockWs();
		const provider = partialFailingProvider(["Hello", " wor"], 500, "Internal Server Error");
		await handlePrompt({ ws, db, provider, model: "test-model", text: "tell me something" });

		const msgs = ws.messages();

		// Tokens yielded before the error should be sent to the client
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " wor" },
		]);

		// Error should be sent to the client
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("500");

		// Partial response should be persisted in the DB
		// Find the session via the user message we sent (unique text avoids cross-test collision)
		const row = db.query("SELECT session_id FROM messages WHERE content = ? LIMIT 1").get("tell me something") as {
			session_id: string;
		};
		const stored = getMessages(db, row.session_id);

		expect(stored).toHaveLength(3); // system + user + partial assistant
		expect(stored[0].role).toBe("system");
		expect(stored[1].role).toBe("user");
		expect(stored[1].content).toBe("tell me something");
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].content).toBe("Hello wor");
	});
});
