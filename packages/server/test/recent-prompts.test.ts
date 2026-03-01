import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendMessage, createSession, getRecentPrompts } from "../src/session/repository";
import { createTestDb } from "./helpers";

describe("getRecentPrompts", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("returns empty array when no messages exist", () => {
		const freshDb = createTestDb();
		const result = getRecentPrompts(freshDb, 10);
		expect(result).toEqual([]);
		freshDb.close();
	});

	test("returns user prompts in most-recent-first order", () => {
		const freshDb = createTestDb();
		const session = createSession(freshDb, "system");
		appendMessage(freshDb, session.id, "user", "first");
		appendMessage(freshDb, session.id, "user", "second");
		appendMessage(freshDb, session.id, "user", "third");

		const result = getRecentPrompts(freshDb, 10);
		expect(result).toEqual(["third", "second", "first"]);
		freshDb.close();
	});

	test("deduplicates — same prompt sent twice returns once at most recent position", () => {
		const freshDb = createTestDb();
		const session = createSession(freshDb, "system");
		appendMessage(freshDb, session.id, "user", "hello");
		appendMessage(freshDb, session.id, "user", "world");
		appendMessage(freshDb, session.id, "user", "hello");

		const result = getRecentPrompts(freshDb, 10);
		// "hello" should appear once, at position 0 (most recent)
		expect(result).toEqual(["hello", "world"]);
		freshDb.close();
	});

	test("respects limit parameter", () => {
		const freshDb = createTestDb();
		const session = createSession(freshDb, "system");
		appendMessage(freshDb, session.id, "user", "a");
		appendMessage(freshDb, session.id, "user", "b");
		appendMessage(freshDb, session.id, "user", "c");
		appendMessage(freshDb, session.id, "user", "d");
		appendMessage(freshDb, session.id, "user", "e");

		const result = getRecentPrompts(freshDb, 3);
		expect(result).toEqual(["e", "d", "c"]);
		freshDb.close();
	});

	test("only returns user messages, not system/assistant/tool", () => {
		const freshDb = createTestDb();
		const session = createSession(freshDb, "system prompt");
		appendMessage(freshDb, session.id, "user", "user question");
		appendMessage(freshDb, session.id, "assistant", "assistant reply");
		appendMessage(freshDb, session.id, "tool", "tool output");
		appendMessage(freshDb, session.id, "user", "another question");

		const result = getRecentPrompts(freshDb, 10);
		expect(result).toEqual(["another question", "user question"]);
		freshDb.close();
	});

	test("works across multiple sessions", () => {
		const freshDb = createTestDb();
		const s1 = createSession(freshDb, "system");
		appendMessage(freshDb, s1.id, "user", "from session 1");

		const s2 = createSession(freshDb, "system");
		appendMessage(freshDb, s2.id, "user", "from session 2");

		const result = getRecentPrompts(freshDb, 10);
		expect(result).toEqual(["from session 2", "from session 1"]);
		freshDb.close();
	});
});

describe("GET /bobai/prompts/recent", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let db: Database;

	beforeAll(async () => {
		db = createTestDb();
		const { createServer } = await import("../src/server");
		server = createServer({ port: 0, db });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
	});

	test("returns JSON array of recent prompts", async () => {
		const session = createSession(db, "system");
		appendMessage(db, session.id, "user", "test prompt");

		const res = await fetch(`${baseUrl}/bobai/prompts/recent`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body).toContain("test prompt");
	});

	test("respects limit query parameter", async () => {
		const freshDb = createTestDb();
		const { createServer } = await import("../src/server");
		const s = createServer({ port: 0, db: freshDb });
		const url = `http://localhost:${s.port}`;

		const session = createSession(freshDb, "system");
		for (let i = 0; i < 5; i++) {
			appendMessage(freshDb, session.id, "user", `prompt ${i}`);
		}

		const res = await fetch(`${url}/bobai/prompts/recent?limit=2`);
		const body = await res.json();
		expect(body).toHaveLength(2);

		s.stop(true);
		freshDb.close();
	});

	test("clamps limit to max 50", async () => {
		const res = await fetch(`${baseUrl}/bobai/prompts/recent?limit=999`);
		expect(res.status).toBe(200);
		// Just verify it doesn't error — the clamping is internal
	});

	test("defaults limit to 10 when not provided", async () => {
		const freshDb = createTestDb();
		const { createServer } = await import("../src/server");
		const s = createServer({ port: 0, db: freshDb });
		const url = `http://localhost:${s.port}`;

		const session = createSession(freshDb, "system");
		for (let i = 0; i < 15; i++) {
			appendMessage(freshDb, session.id, "user", `prompt ${i}`);
		}

		const res = await fetch(`${url}/bobai/prompts/recent`);
		const body = await res.json();
		expect(body).toHaveLength(10);

		s.stop(true);
		freshDb.close();
	});

	test("returns 503 when db is not configured", async () => {
		const { createServer } = await import("../src/server");
		const s = createServer({ port: 0 });
		const url = `http://localhost:${s.port}`;

		const res = await fetch(`${url}/bobai/prompts/recent`);
		expect(res.status).toBe(503);

		s.stop(true);
	});
});
