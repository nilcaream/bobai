# Multi-Turn Conversations Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-side session state so the LLM sees the full conversation history, not just the current message.

**Architecture:** SQLite stores sessions and messages. The handler loads all messages from the DB before each LLM call and appends user/assistant messages as they arrive. The WebSocket protocol gains an optional `sessionId` field. Omitting it creates a new session; including it resumes an existing one.

**Tech Stack:** Bun SQLite (`bun:sqlite`), existing WebSocket server, React 19 frontend.

**Conventions:** Bun runtime, TypeScript, Biome (tabs, 128-char lines), `bun:test`, Conventional Commits.

---

### Task 1: Create SQLite Schema in `initProject`

**Files:**
- Modify: `packages/server/src/project.ts:39` (after `new Database(...)`)
- Test: `packages/server/test/project.test.ts` (existing — update to verify tables)

**Step 1: Write the failing test**

Add a test to the existing `project.test.ts` that verifies the `sessions` and `messages` tables exist after `initProject`:

```typescript
test("creates sessions and messages tables", async () => {
	const project = await initProject(tmpDir);
	const tables = project.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	const names = tables.map((t) => t.name);
	expect(names).toContain("sessions");
	expect(names).toContain("messages");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/project.test.ts`
Expected: FAIL — tables don't exist yet.

**Step 3: Write the implementation**

In `packages/server/src/project.ts`, after `const db = new Database(dbFile, { create: true })`, add:

```typescript
db.exec(`
	CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		title      TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)
`);
db.exec(`
	CREATE TABLE IF NOT EXISTS messages (
		id         TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		role       TEXT NOT NULL,
		content    TEXT NOT NULL,
		created_at TEXT NOT NULL,
		sort_order INTEGER NOT NULL
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sort_order)`);
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/project.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): create sessions and messages tables in SQLite
```

---

### Task 2: Build Session Repository

**Files:**
- Create: `packages/server/src/session/repository.ts`
- Test: `packages/server/test/repository.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/repository.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendMessage,
	createSession,
	getMessages,
	getSession,
	listSessions,
} from "../src/session/repository";

function createTestDb(): Database {
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
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/repository.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/session/repository.ts`:

```typescript
import type { Database } from "bun:sqlite";

export interface Session {
	id: string;
	title: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredMessage {
	id: string;
	sessionId: string;
	role: "system" | "user" | "assistant";
	content: string;
	createdAt: string;
	sortOrder: number;
}

export function createSession(db: Database, systemPrompt: string): Session {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);

	db.prepare(
		"INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
	).run(crypto.randomUUID(), id, "system", systemPrompt, now, 0);

	return { id, title: null, createdAt: now, updatedAt: now };
}

export function appendMessage(db: Database, sessionId: string, role: "user" | "assistant", content: string): StoredMessage {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	const maxRow = db.prepare("SELECT MAX(sort_order) as max_order FROM messages WHERE session_id = ?").get(sessionId) as {
		max_order: number | null;
	} | null;
	const sortOrder = (maxRow?.max_order ?? -1) + 1;

	db.prepare(
		"INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
	).run(id, sessionId, role, content, now, sortOrder);

	db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);

	return { id, sessionId, role, content, createdAt: now, sortOrder };
}

export function getMessages(db: Database, sessionId: string): StoredMessage[] {
	const rows = db
		.prepare("SELECT id, session_id, role, content, created_at, sort_order FROM messages WHERE session_id = ? ORDER BY sort_order")
		.all(sessionId) as { id: string; session_id: string; role: string; content: string; created_at: string; sort_order: number }[];

	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		role: r.role as "system" | "user" | "assistant",
		content: r.content,
		createdAt: r.created_at,
		sortOrder: r.sort_order,
	}));
}

export function getSession(db: Database, sessionId: string): Session | null {
	const row = db.prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?").get(sessionId) as {
		id: string;
		title: string | null;
		created_at: string;
		updated_at: string;
	} | null;

	if (!row) return null;
	return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listSessions(db: Database): Session[] {
	const rows = db
		.prepare("SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC")
		.all() as { id: string; title: string | null; created_at: string; updated_at: string }[];

	return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/repository.test.ts`
Expected: PASS — all 7 tests.

**Step 5: Commit**

```
feat(server): add session repository with CRUD operations
```

---

### Task 3: Extend WebSocket Protocol

**Files:**
- Modify: `packages/server/src/protocol.ts`
- Test: `packages/server/test/protocol.test.ts` (new — protocol types are trivial but the `send` function deserves a test)

**Step 1: Write the failing test**

Create `packages/server/test/protocol.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { send } from "../src/protocol";

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

describe("protocol", () => {
	test("send done includes sessionId", () => {
		const ws = mockWs();
		send(ws, { type: "done", sessionId: "abc-123" });
		expect(ws.messages()[0]).toEqual({ type: "done", sessionId: "abc-123" });
	});

	test("send token message unchanged", () => {
		const ws = mockWs();
		send(ws, { type: "token", text: "hello" });
		expect(ws.messages()[0]).toEqual({ type: "token", text: "hello" });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/protocol.test.ts`
Expected: FAIL — `done` message type doesn't accept `sessionId` yet.

**Step 3: Write the implementation**

Replace `packages/server/src/protocol.ts`:

```typescript
// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
```

**Step 4: Fix compile errors in existing code**

After changing the `done` type to require `sessionId`, existing code that sends `{ type: "done" }` without a `sessionId` will fail type checks. These fixes happen in Task 5 (handler rewrite). For now, run the protocol test alone.

Run: `bun test packages/server/test/protocol.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): extend protocol with sessionId in prompt and done messages
```

---

### Task 4: Improve System Prompt

**Files:**
- Create: `packages/server/src/system-prompt.ts`
- Test: `packages/server/test/system-prompt.test.ts`

**Step 1: Write the failing test**

Create `packages/server/test/system-prompt.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../src/system-prompt";

describe("system prompt", () => {
	test("is a non-empty string", () => {
		expect(typeof SYSTEM_PROMPT).toBe("string");
		expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
	});

	test("identifies as Bob AI", () => {
		expect(SYSTEM_PROMPT).toContain("Bob AI");
	});

	test("states limitations", () => {
		// Should mention it cannot access files (yet)
		expect(SYSTEM_PROMPT.toLowerCase()).toContain("cannot");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/system-prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `You are Bob AI, a coding assistant.

You help developers write, understand, debug, and improve code. You give clear, direct answers. When a question is ambiguous, you ask for clarification rather than guess.

Current limitations:
- You cannot read or modify files on the user's machine.
- You cannot execute commands or run code.
- You have no access to the project's source tree.

These limitations are temporary. For now, work with what the user provides in the conversation.`;
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add improved system prompt
```

---

### Task 5: Rewrite Handler for Session-Aware Conversations

This is the core task. The handler changes from stateless to session-aware.

**Files:**
- Modify: `packages/server/src/handler.ts`
- Modify: `packages/server/test/handler.test.ts`

**Step 1: Write the failing tests**

Replace `packages/server/test/handler.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/handler.test.ts`
Expected: FAIL — `handlePrompt` signature doesn't match.

**Step 3: Write the implementation**

Replace `packages/server/src/handler.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { send } from "./protocol";
import type { Message, Provider } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import { appendMessage, createSession, getMessages, getSession } from "./session/repository";
import { SYSTEM_PROMPT } from "./system-prompt";

export interface PromptRequest {
	ws: { send: (msg: string) => void };
	db: Database;
	provider: Provider;
	model: string;
	text: string;
	sessionId?: string;
}

export async function handlePrompt(req: PromptRequest) {
	const { ws, db, provider, model, text, sessionId } = req;

	try {
		// Resolve or create session
		let currentSessionId: string;
		if (sessionId) {
			const session = getSession(db, sessionId);
			if (!session) {
				send(ws, { type: "error", message: `Session not found: ${sessionId}` });
				return;
			}
			currentSessionId = sessionId;
		} else {
			const session = createSession(db, SYSTEM_PROMPT);
			currentSessionId = session.id;
		}

		// Persist the user message
		appendMessage(db, currentSessionId, "user", text);

		// Load full conversation history
		const stored = getMessages(db, currentSessionId);
		const messages: Message[] = stored.map((m) => ({ role: m.role, content: m.content }));

		// Stream from provider
		let fullResponse = "";
		for await (const chunk of provider.stream({ model, messages })) {
			fullResponse += chunk;
			send(ws, { type: "token", text: chunk });
		}

		// Persist the assistant response
		appendMessage(db, currentSessionId, "assistant", fullResponse);

		send(ws, { type: "done", sessionId: currentSessionId });
	} catch (err) {
		const message =
			err instanceof ProviderError ? `Provider error (${err.status}): ${err.body}` : "Unexpected error during generation";
		send(ws, { type: "error", message });
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/handler.test.ts`
Expected: PASS — all 6 tests.

**Step 5: Commit**

```
feat(server): rewrite handler for session-aware multi-turn conversations
```

---

### Task 6: Wire DB Through Server and Update Entry Point

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/test/session.test.ts`

**Step 1: Update session integration test**

Rewrite `packages/server/test/session.test.ts` to create an in-memory DB and pass it through the server. Test multi-turn conversation over WebSocket:

```typescript
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Provider } from "../src/provider/provider";
import { createServer } from "../src/server";

function initTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, title TEXT,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL, content TEXT NOT NULL,
			created_at TEXT NOT NULL, sort_order INTEGER NOT NULL
		)
	`);
	db.exec("CREATE INDEX idx_messages_session ON messages(session_id, sort_order)");
	return db;
}

function sendAndCollect(wsUrl: string, payload: object): Promise<{ type: string; text?: string; sessionId?: string; message?: string }[]> {
	return new Promise((resolve, reject) => {
		const received: { type: string; text?: string; sessionId?: string; message?: string }[] = [];
		const ws = new WebSocket(wsUrl);
		ws.onopen = () => ws.send(JSON.stringify(payload));
		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data as string);
			received.push(msg);
			if (msg.type === "done" || msg.type === "error") ws.close();
		};
		ws.onclose = () => resolve(received);
		ws.onerror = (err) => reject(err);
	});
}

describe("server session integration", () => {
	let server: ReturnType<typeof Bun.serve>;
	let wsUrl: string;

	beforeAll(() => {
		const provider: Provider = {
			id: "test",
			async *stream() {
				yield "test ";
				yield "response";
			},
		};
		const db = initTestDb();
		server = createServer({ port: 0, provider, model: "test-model", db });
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("first prompt creates session and returns sessionId in done", async () => {
		const msgs = await sendAndCollect(wsUrl, { type: "prompt", text: "hello" });
		const done = msgs.find((m) => m.type === "done");
		expect(done).toBeTruthy();
		expect(done!.sessionId).toBeTruthy();
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

	test("sends error for unknown message type", async () => {
		const msgs = await sendAndCollect(wsUrl, { type: "unknown" });
		expect(msgs[0].type).toBe("error");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/session.test.ts`
Expected: FAIL — `createServer` doesn't accept `db`.

**Step 3: Update server.ts**

Modify `packages/server/src/server.ts` to accept and thread `db`:

```typescript
import type { Database } from "bun:sqlite";
import path from "node:path";
import { handlePrompt } from "./handler";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import type { Provider } from "./provider/provider";

export interface ServerOptions {
	port: number;
	staticDir?: string;
	provider?: Provider;
	model?: string;
	db?: Database;
}

export function createServer(options: ServerOptions) {
	const staticDir = options.staticDir;

	return Bun.serve({
		port: options.port,
		fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/bobai/ws") {
				const upgraded = server.upgrade(req);
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bobai/health") {
				return Response.json({ status: "ok" });
			}

			if (staticDir && url.pathname.startsWith("/bobai")) {
				const relative = url.pathname.replace(/^\/bobai\/?/, "");
				const filePath = path.join(staticDir, relative || "index.html");
				const file = Bun.file(filePath);
				return file.exists().then((exists) => {
					if (exists) return new Response(file);
					return new Response("Not Found", { status: 404 });
				});
			}

			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				let msg: ClientMessage;
				try {
					msg = JSON.parse(raw as string) as ClientMessage;
				} catch {
					send(ws, { type: "error", message: "Invalid JSON" });
					return;
				}

				if (msg.type === "prompt") {
					if (options.provider && options.model && options.db) {
						handlePrompt({
							ws,
							db: options.db,
							provider: options.provider,
							model: options.model,
							text: msg.text,
							sessionId: msg.sessionId,
						});
					} else {
						send(ws, { type: "error", message: "No provider configured" });
					}
					return;
				}

				send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
			},
		},
	});
}
```

**Step 4: Update index.ts**

In `packages/server/src/index.ts`, pass `project.db` to `createServer`:

Change line 44 from:
```typescript
const server = createServer({ port, staticDir, provider, model: config.model });
```
to:
```typescript
const server = createServer({ port, staticDir, provider, model: config.model, db: project.db });
```

**Step 5: Run tests**

Run: `bun test packages/server/test/session.test.ts`
Expected: PASS — all 4 tests.

Run: `bun test packages/server/test/`
Expected: All tests pass (previous tests may need minor adjustments if they relied on the old `done` message shape — fix any such failures).

**Step 6: Commit**

```
feat(server): wire database through server to handler
```

---

### Task 7: Update Frontend for Session Tracking and New Chat

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts`
- Modify: `packages/ui/src/App.tsx`

No automated tests for the UI — verify manually or via the integration test.

**Step 1: Update useWebSocket.ts**

```typescript
import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage =
	| { type: "token"; text: string }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };

export type Message = { role: "user" | "assistant"; text: string };

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);
	const sessionId = useRef<string | null>(null);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			if (msg.type === "token") {
				setMessages((prev) => {
					const last = prev.at(-1);
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
					}
					return [...prev, { role: "assistant", text: msg.text }];
				});
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
			}

			if (msg.type === "error") {
				setMessages((prev) => [
					...prev,
					{ role: "assistant", text: `Error: ${msg.message}` },
				]);
			}
		};

		ws.current = socket;
		return () => socket.close();
	}, []);

	const sendPrompt = useCallback((text: string) => {
		if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
		setMessages((prev) => [...prev, { role: "user", text }]);
		const payload: { type: string; text: string; sessionId?: string } = { type: "prompt", text };
		if (sessionId.current) {
			payload.sessionId = sessionId.current;
		}
		ws.current.send(JSON.stringify(payload));
	}, []);

	const newChat = useCallback(() => {
		sessionId.current = null;
		setMessages([]);
	}, []);

	return { messages, connected, sendPrompt, newChat };
}
```

**Step 2: Update App.tsx**

Add a "New Chat" button to the header:

```tsx
import { useRef, useState } from "react";
import { useWebSocket } from "./useWebSocket";

export function App() {
	const { messages, connected, sendPrompt, newChat } = useWebSocket();
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;
		sendPrompt(text);
		setInput("");
		setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
	}

	return (
		<main style={{ display: "flex", flexDirection: "column", height: "100vh", padding: "1rem" }}>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
				<div>
					<h1 style={{ margin: 0 }}>Bob AI</h1>
					<small>{connected ? "connected" : "connecting..."}</small>
				</div>
				<button type="button" onClick={newChat} disabled={!connected || messages.length === 0}>
					New Chat
				</button>
			</header>

			<section
				style={{
					flex: 1,
					overflowY: "auto",
					padding: "1rem 0",
					display: "flex",
					flexDirection: "column",
					gap: "0.5rem",
				}}
			>
				{messages.map((msg, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						key={i}
						style={{
							alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
							background: msg.role === "user" ? "#0070f3" : "#222",
							color: "#fff",
							borderRadius: "8px",
							padding: "0.5rem 0.75rem",
							maxWidth: "70%",
							whiteSpace: "pre-wrap",
						}}
					>
						{msg.text}
					</div>
				))}
				<div ref={bottomRef} />
			</section>

			<footer style={{ display: "flex", gap: "0.5rem" }}>
				<input
					style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					placeholder="Type a message..."
					disabled={!connected}
				/>
				<button type="button" onClick={submit} disabled={!connected}>
					Send
				</button>
			</footer>
		</main>
	);
}
```

**Step 3: Rebuild the UI**

Run: `bun run build` (from `packages/ui/`)

**Step 4: Commit**

```
feat(ui): track session ID and add New Chat button
```

---

### Task 8: Final Verification

**Step 1: Run full test suite**

Run: `bun test packages/server/test/`
Expected: All tests pass, no regressions.

**Step 2: Run Biome**

Run: `bunx biome check packages/server/src packages/server/test packages/ui/src`
Expected: Clean.

**Step 3: PII/security review**

Run: `rg -n '<username>|/home/|\.env|password|secret|api.key|apiKey' packages/server/src/ packages/server/test/ packages/ui/src/ --type ts`
(Replace `<username>` with your actual username before running.)
Expected: Only `process.env.XDG_DATA_HOME || path.join(os.homedir(), ...)` — no hardcoded paths or secrets.

**Step 4: Commit (if any fixups needed)**

```
chore: final cleanup for multi-turn conversations
```
