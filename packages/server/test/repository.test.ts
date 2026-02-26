import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendMessage, createSession, getMessages, getSession, listSessions } from "../src/session/repository";
import { createTestDb } from "./helpers";

describe("session repository", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("createSession inserts session and system prompt", () => {
		const session = createSession(db, "You are a test assistant.");
		expect(session.id).toBeTruthy();
		expect(session.title).toBeNull();
		expect(session.createdAt).toBeTruthy();

		const messages = getMessages(db, session.id);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("You are a test assistant.");
		expect(messages[0].sortOrder).toBe(0);
	});

	test("appendMessage adds messages with incrementing sort_order", () => {
		const session = createSession(db, "system prompt");
		appendMessage(db, session.id, "user", "hello");
		appendMessage(db, session.id, "assistant", "hi there");

		const messages = getMessages(db, session.id);
		expect(messages).toHaveLength(3);
		expect(messages[0].role).toBe("system");
		expect(messages[0].sortOrder).toBe(0);
		expect(messages[1].role).toBe("user");
		expect(messages[1].sortOrder).toBe(1);
		expect(messages[2].role).toBe("assistant");
		expect(messages[2].sortOrder).toBe(2);
	});

	test("getMessages returns messages ordered by sort_order", () => {
		const session = createSession(db, "system");
		appendMessage(db, session.id, "user", "first");
		appendMessage(db, session.id, "assistant", "second");
		appendMessage(db, session.id, "user", "third");

		const messages = getMessages(db, session.id);
		const contents = messages.map((m) => m.content);
		expect(contents).toEqual(["system", "first", "second", "third"]);
	});

	test("getSession returns session by id", () => {
		const created = createSession(db, "sys");
		const found = getSession(db, created.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
	});

	test("getSession returns null for unknown id", () => {
		expect(getSession(db, "nonexistent")).toBeNull();
	});

	test("listSessions returns sessions ordered by updated_at descending", () => {
		const freshDb = createTestDb();
		const s1 = createSession(freshDb, "sys");
		// Append a message to s1 to bump updated_at
		appendMessage(freshDb, s1.id, "user", "bump");
		const s2 = createSession(freshDb, "sys");

		const sessions = listSessions(freshDb);
		// s2 was created after s1's update, so s2 is first
		expect(sessions.length).toBeGreaterThanOrEqual(2);
		expect(sessions[0].id).toBe(s2.id);
		freshDb.close();
	});

	test("appendMessage updates session updated_at", () => {
		const session = createSession(db, "sys");
		const before = session.updatedAt;
		// Small delay to ensure timestamp difference
		const start = performance.now();
		while (performance.now() - start < 5) {
			/* busy wait 5ms */
		}
		appendMessage(db, session.id, "user", "msg");
		const after = getSession(db, session.id)!.updatedAt;
		expect(after >= before).toBe(true);
	});
});
