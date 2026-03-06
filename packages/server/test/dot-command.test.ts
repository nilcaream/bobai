import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/command";
import { handlePrompt } from "../src/handler";
import { CURATED_MODELS } from "../src/provider/copilot-models";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createServer } from "../src/server";
import {
	appendMessage,
	createSession,
	createSubagentSession,
	getSession,
	updateSessionModel,
	updateSessionTitle,
} from "../src/session/repository";
import { createTestDb } from "./helpers";

describe("session model field", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("new session has null model", () => {
		const session = createSession(db, "system prompt");
		expect(session.model).toBeNull();
	});

	test("updateSessionModel sets the model", () => {
		const session = createSession(db, "system prompt");
		updateSessionModel(db, session.id, "claude-sonnet-4.6");
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe("claude-sonnet-4.6");
	});

	test("getSession returns model field", () => {
		const session = createSession(db, "system prompt");
		const fetched = getSession(db, session.id);
		expect(fetched).toHaveProperty("model");
		expect(fetched?.model).toBeNull();
	});
});

describe("session title update", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("updateSessionTitle sets the title", () => {
		const session = createSession(db, "system prompt");
		updateSessionTitle(db, session.id, "My Chat");
		const updated = getSession(db, session.id);
		expect(updated?.title).toBe("My Chat");
	});
});

describe("handleCommand", () => {
	let db: Database;
	let tmpDir: string;

	beforeAll(() => {
		db = createTestDb();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-test-"));
	});

	afterAll(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("model command updates session model and returns status", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "1", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toBe("gpt-4o | 0x | 0 tokens");
			expect(result.sessionId).toBe(session.id);
		}
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe(CURATED_MODELS[0]);
	});

	test("model command rejects invalid index", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "99", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Invalid model index");
	});

	test("model command creates session when none provided", () => {
		const result = handleCommand(db, { command: "model", args: "1" }, tmpDir);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sessionId).toBeDefined();
			expect(result.status).toBe("gpt-4o | 0x | 0 tokens");
			const session = getSession(db, result.sessionId ?? "");
			expect(session?.model).toBe(CURATED_MODELS[0]);
		}
	});

	test("title command updates session title", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "title", args: "My Chat Title", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated?.title).toBe("My Chat Title");
	});

	test("title command rejects empty title", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "title", args: "", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Title cannot be empty");
	});

	test("session command returns ok (no-op)", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "session", args: "", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(true);
	});

	test("unknown command returns error", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "foo", args: "", sessionId: session.id }, tmpDir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Unknown command");
	});

	test("subagent command lists recent subagent sessions", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb, "sys");
		createSubagentSession(freshDb, parent.id, "Task Alpha", "gpt-5-mini", "sys");
		createSubagentSession(freshDb, parent.id, "Task Beta", "gpt-5-mini", "sys");

		const result = handleCommand(freshDb, { command: "subagent", args: "", sessionId: parent.id });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toContain("Task Beta");
			expect(result.status).toContain("Task Alpha");
		}
		freshDb.close();
	});

	test("subagent command returns empty message when no subagents", () => {
		const freshDb = createTestDb();
		const parent = createSession(freshDb, "sys");
		const result = handleCommand(freshDb, { command: "subagent", args: "", sessionId: parent.id });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toContain("No subagent sessions");
		}
		freshDb.close();
	});
});

describe("HTTP endpoints", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let db: Database;
	let tmpDir: string;

	beforeAll(() => {
		db = createTestDb();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-test-"));
		server = createServer({ port: 0, db, configDir: tmpDir });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("GET /bobai/models returns curated model list with cost strings, defaultModel and defaultStatus", async () => {
		const res = await fetch(`${baseUrl}/bobai/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: { index: number; id: string; cost: string }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.models.length).toBe(CURATED_MODELS.length);
		expect(body.models[0].index).toBe(1);
		expect(body.models[0].id).toBe(CURATED_MODELS[0]);
		expect(body.models[0].cost).toBe("0x");
		expect(body.defaultModel).toBe("gpt-5-mini");
		expect(body.defaultStatus).toBe("gpt-5-mini | 0x | 0 tokens");
	});

	test("POST /bobai/command executes model command and returns status", async () => {
		const session = createSession(db, "system prompt");
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "1", sessionId: session.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; status?: string };
		expect(body.ok).toBe(true);
		expect(body.status).toBe("gpt-4o | 0x | 0 tokens");
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe(CURATED_MODELS[0]);
	});

	test("POST /bobai/command returns error for bad command", async () => {
		const session = createSession(db, "system prompt");
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "foo", args: "", sessionId: session.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("Unknown command");
	});

	test("GET /bobai/subagents returns recent subagent sessions", async () => {
		const parent = createSession(db, "sys");
		createSubagentSession(db, parent.id, "HTTP Task A", "gpt-5-mini", "sys");

		const res = await fetch(`${baseUrl}/bobai/subagents?parentId=${parent.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { index: number; title: string; sessionId: string }[];
		expect(body.length).toBeGreaterThanOrEqual(1);
		const match = body.find((s) => s.title === "HTTP Task A");
		expect(match).toBeTruthy();
		expect(match?.sessionId).toBeTruthy();
	});

	test("GET /bobai/sessions returns parent sessions sorted by updated_at", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const s1 = createSession(freshDb, "sys");
		updateSessionTitle(freshDb, s1.id, "First");
		const s2 = createSession(freshDb, "sys");
		updateSessionTitle(freshDb, s2.id, "Second");
		// s2 is more recent
		const res = await fetch(`${base}/bobai/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { index: number; id: string; title: string | null; updatedAt: string }[];
		expect(body.length).toBeGreaterThanOrEqual(2);
		expect(body[0].title).toBe("Second");
		expect(body[0].index).toBe(1);
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/sessions/recent returns most recent parent session", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		createSession(freshDb, "sys");
		const s2 = createSession(freshDb, "sys");
		updateSessionTitle(freshDb, s2.id, "Latest");
		const res = await fetch(`${base}/bobai/sessions/recent`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; title: string | null; model: string | null } | null;
		expect(body).not.toBeNull();
		expect(body?.id).toBe(s2.id);
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/sessions/recent returns null when no sessions", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const res = await fetch(`${base}/bobai/sessions/recent`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toBeNull();
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/session/:id/load returns session metadata and messages", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const session = createSession(freshDb, "sys");
		updateSessionTitle(freshDb, session.id, "Test Session");
		appendMessage(freshDb, session.id, "user", "hello");
		appendMessage(freshDb, session.id, "assistant", "hi there");
		const res = await fetch(`${base}/bobai/session/${session.id}/load`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			session: { id: string; title: string; model: string | null; parentId: string | null };
			messages: { role: string; content: string }[];
		};
		expect(body.session.id).toBe(session.id);
		expect(body.session.title).toBe("Test Session");
		expect(body.messages.length).toBe(3); // system + user + assistant
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/session/:id/load returns 404 for unknown session", async () => {
		const res = await fetch(`${baseUrl}/bobai/session/nonexistent/load`);
		expect(res.status).toBe(404);
	});
});

describe("handlePrompt respects session model", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("uses session model when set", async () => {
		const session = createSession(db, "system prompt");
		updateSessionModel(db, session.id, "claude-sonnet-4.6");

		const captured: ProviderOptions[] = [];
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		expect(captured[0].model).toBe("claude-sonnet-4.6");
	});

	test("falls back to default model when session model is null", async () => {
		const session = createSession(db, "system prompt");

		const captured: ProviderOptions[] = [];
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		expect(captured[0].model).toBe("gpt-5-mini");
	});

	test("done message includes session model when set", async () => {
		const session = createSession(db, "system prompt");
		updateSessionModel(db, session.id, "claude-opus-4.6");

		const provider: Provider = {
			id: "mock",
			async *stream(): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		const msgs = sent.map((s) => JSON.parse(s));
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.model).toBe("claude-opus-4.6");
	});

	test("done message includes session title", async () => {
		const session = createSession(db, "system prompt");
		updateSessionTitle(db, session.id, "Test Title");

		const provider: Provider = {
			id: "mock",
			async *stream(): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		const msgs = sent.map((s) => JSON.parse(s));
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.title).toBe("Test Title");
	});
});
