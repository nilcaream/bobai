import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleCommand } from "../src/command";
import { handlePrompt } from "../src/handler";
import { CURATED_MODELS } from "../src/provider/copilot-models";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createServer } from "../src/server";
import { createSession, getSession, updateSessionModel, updateSessionTitle } from "../src/session/repository";
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
		expect(updated!.model).toBe("claude-sonnet-4.6");
	});

	test("getSession returns model field", () => {
		const session = createSession(db, "system prompt");
		const fetched = getSession(db, session.id);
		expect(fetched).toHaveProperty("model");
		expect(fetched!.model).toBeNull();
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
		expect(updated!.title).toBe("My Chat");
	});
});

describe("handleCommand", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("model command updates session model and returns status", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "1", sessionId: session.id });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toBe("gpt-4o | 0x");
			expect(result.sessionId).toBe(session.id);
		}
		const updated = getSession(db, session.id);
		expect(updated!.model).toBe(CURATED_MODELS[0]);
	});

	test("model command rejects invalid index", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "99", sessionId: session.id });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Invalid model index");
	});

	test("model command creates session when none provided", () => {
		const result = handleCommand(db, { command: "model", args: "1" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sessionId).toBeDefined();
			expect(result.status).toBe("gpt-4o | 0x");
			const session = getSession(db, result.sessionId!);
			expect(session!.model).toBe(CURATED_MODELS[0]);
		}
	});

	test("title command updates session title", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "title", args: "My Chat Title", sessionId: session.id });
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated!.title).toBe("My Chat Title");
	});

	test("title command rejects empty title", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "title", args: "", sessionId: session.id });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Title cannot be empty");
	});

	test("session command returns not implemented", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "session", args: "", sessionId: session.id });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not implemented");
	});

	test("unknown command returns error", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "foo", args: "", sessionId: session.id });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Unknown command");
	});
});

describe("HTTP endpoints", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
		server = createServer({ port: 0, db });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
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
		expect(body.defaultStatus).toBe("gpt-5-mini | 0x");
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
		expect(body.status).toBe("gpt-4o | 0x");
		const updated = getSession(db, session.id);
		expect(updated!.model).toBe(CURATED_MODELS[0]);
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

		// First message should be the initial status
		const msgs = sent.map((s) => JSON.parse(s));
		const firstStatus = msgs.find((m: { type: string }) => m.type === "status");
		expect(firstStatus.text).toBe("claude-sonnet-4.6 | 1x");
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

		// Initial status should use the default model
		const msgs = sent.map((s) => JSON.parse(s));
		const firstStatus = msgs.find((m: { type: string }) => m.type === "status");
		expect(firstStatus.text).toBe("gpt-5-mini | 0x");
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
