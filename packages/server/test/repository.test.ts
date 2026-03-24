import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendMessage,
	createSession,
	createSubagentSession,
	getMessages,
	getMostRecentParentSession,
	getSession,
	listSessions,
	listSubagentSessions,
} from "../src/session/repository";
import { createTestDb } from "./helpers";

describe("session repository", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("createSession inserts session with no messages", () => {
		const session = createSession(db);
		expect(session.id).toBeTruthy();
		expect(session.title).toBeNull();
		expect(session.createdAt).toBeTruthy();

		const messages = getMessages(db, session.id);
		expect(messages).toHaveLength(0);
	});

	test("appendMessage adds messages with incrementing sort_order", () => {
		const session = createSession(db);
		appendMessage(db, session.id, "user", "hello");
		appendMessage(db, session.id, "assistant", "hi there");

		const messages = getMessages(db, session.id);
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messages[0].sortOrder).toBe(0);
		expect(messages[1].role).toBe("assistant");
		expect(messages[1].sortOrder).toBe(1);
	});

	test("getMessages returns messages ordered by sort_order", () => {
		const session = createSession(db);
		appendMessage(db, session.id, "user", "first");
		appendMessage(db, session.id, "assistant", "second");
		appendMessage(db, session.id, "user", "third");

		const messages = getMessages(db, session.id);
		const contents = messages.map((m) => m.content);
		expect(contents).toEqual(["first", "second", "third"]);
	});

	test("getSession returns session by id", () => {
		const created = createSession(db);
		const found = getSession(db, created.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(created.id);
	});

	test("getSession returns null for unknown id", () => {
		expect(getSession(db, "nonexistent")).toBeNull();
	});

	test("listSessions returns sessions ordered by updated_at descending", () => {
		const freshDb = createTestDb();
		const s1 = createSession(freshDb);
		// Append a message to s1 to bump updated_at
		appendMessage(freshDb, s1.id, "user", "bump");
		const s2 = createSession(freshDb);

		const sessions = listSessions(freshDb);
		// s2 was created after s1's update, so s2 is first
		expect(sessions.length).toBeGreaterThanOrEqual(2);
		expect(sessions[0].id).toBe(s2.id);
		freshDb.close();
	});

	test("appendMessage updates session updated_at", () => {
		const session = createSession(db);
		const before = session.updatedAt;
		// Small delay to ensure timestamp difference
		const start = performance.now();
		while (performance.now() - start < 5) {
			/* busy wait 5ms */
		}
		appendMessage(db, session.id, "user", "msg");
		const after = getSession(db, session.id)?.updatedAt;
		expect(after >= before).toBe(true);
	});

	test("appendMessage stores and retrieves metadata", () => {
		const session = createSession(db);
		const toolCalls = [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }];
		appendMessage(db, session.id, "assistant", "", { tool_calls: toolCalls });

		const messages = getMessages(db, session.id);
		const assistantMsg = messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeTruthy();
		expect(assistantMsg?.metadata).toEqual({ tool_calls: toolCalls });
	});

	test("appendMessage supports tool role with tool_call_id metadata", () => {
		const session = createSession(db);
		appendMessage(db, session.id, "tool", "file contents", { tool_call_id: "call_1" });

		const messages = getMessages(db, session.id);
		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect(toolMsg?.content).toBe("file contents");
		expect(toolMsg?.metadata).toEqual({ tool_call_id: "call_1" });
	});

	test("appendMessage returns null metadata when none provided", () => {
		const session = createSession(db);
		appendMessage(db, session.id, "user", "hello");
		const messages = getMessages(db, session.id);
		const userMsg = messages.find((m) => m.role === "user");
		expect(userMsg?.metadata).toBeNull();
	});

	test("createSubagentSession creates a session with parent_id", () => {
		const parent = createSession(db);
		const child = createSubagentSession(db, parent.id, "Exploring codebase", "gpt-5-mini");
		expect(child.id).toBeTruthy();
		expect(child.title).toBe("Exploring codebase");
		expect(child.parentId).toBe(parent.id);

		const messages = getMessages(db, child.id);
		expect(messages).toHaveLength(0);
	});

	test("listSessions excludes subagent sessions", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb);
		createSubagentSession(freshDb, parent.id, "Child task", "m");

		const sessions = listSessions(freshDb);
		expect(sessions).toHaveLength(1); // only the parent
		expect(sessions[0].id).toBe(parent.id);
		freshDb.close();
	});

	test("listSubagentSessions returns only subagent sessions ordered by updated_at", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb);
		const c1 = createSubagentSession(freshDb, parent.id, "Task A", "gpt-5-mini");
		appendMessage(freshDb, c1.id, "user", "bump"); // bump c1's updated_at
		const c2 = createSubagentSession(freshDb, parent.id, "Task B", "gpt-5-mini");

		const subagents = listSubagentSessions(freshDb, parent.id, 5);
		expect(subagents).toHaveLength(2);
		// c2 was created after c1's update, so c2 is first
		expect(subagents[0].id).toBe(c2.id);
		expect(subagents[0].title).toBe("Task B");
		expect(subagents[0].parentId).toBe(parent.id);
		expect(subagents[1].id).toBe(c1.id);
		freshDb.close();
	});

	test("listSubagentSessions respects limit", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb);
		createSubagentSession(freshDb, parent.id, "A", "m");
		createSubagentSession(freshDb, parent.id, "B", "m");
		createSubagentSession(freshDb, parent.id, "C", "m");

		const subagents = listSubagentSessions(freshDb, parent.id, 2);
		expect(subagents).toHaveLength(2);
		freshDb.close();
	});

	test("listSubagentSessions does not return regular sessions", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb);
		const subagents = listSubagentSessions(freshDb, parent.id);
		expect(subagents).toHaveLength(0);
		freshDb.close();
	});

	test("listSubagentSessions filters by parentId", () => {
		const freshDb = createTestDb();
		const parent1 = createSession(freshDb);
		const parent2 = createSession(freshDb);
		createSubagentSession(freshDb, parent1.id, "P1 Child A", "m");
		createSubagentSession(freshDb, parent1.id, "P1 Child B", "m");
		createSubagentSession(freshDb, parent2.id, "P2 Child A", "m");

		const p1Subagents = listSubagentSessions(freshDb, parent1.id);
		expect(p1Subagents).toHaveLength(2);
		expect(p1Subagents.every((s) => s.parentId === parent1.id)).toBe(true);

		const p2Subagents = listSubagentSessions(freshDb, parent2.id);
		expect(p2Subagents).toHaveLength(1);
		expect(p2Subagents[0].title).toBe("P2 Child A");
		expect(p2Subagents[0].parentId).toBe(parent2.id);
		freshDb.close();
	});

	test("getMostRecentParentSession returns the most recently updated parent session", () => {
		const freshDb = createTestDb();
		const s1 = createSession(freshDb);
		createSession(freshDb);
		// Set s1's updated_at to a future timestamp so it's definitively more recent
		freshDb.prepare("UPDATE sessions SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(s1.id);

		const recent = getMostRecentParentSession(freshDb);
		expect(recent).not.toBeNull();
		expect(recent?.id).toBe(s1.id);
		freshDb.close();
	});

	test("getMostRecentParentSession returns null when no sessions exist", () => {
		const freshDb = createTestDb();
		const recent = getMostRecentParentSession(freshDb);
		expect(recent).toBeNull();
		freshDb.close();
	});

	test("getMostRecentParentSession excludes subagent sessions", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb);
		const child = createSubagentSession(freshDb, parent.id, "Child", "m");
		// bump child so it's more recent than parent
		appendMessage(freshDb, child.id, "user", "bump");

		const recent = getMostRecentParentSession(freshDb);
		expect(recent).not.toBeNull();
		expect(recent?.id).toBe(parent.id);
		freshDb.close();
	});

	test("listSessions with limit parameter", () => {
		const freshDb = createTestDb();
		createSession(freshDb);
		createSession(freshDb);
		createSession(freshDb);

		const limited = listSessions(freshDb, 2);
		expect(limited).toHaveLength(2);

		const unlimited = listSessions(freshDb);
		expect(unlimited).toHaveLength(3);
		freshDb.close();
	});
});
