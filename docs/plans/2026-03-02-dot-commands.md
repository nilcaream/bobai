# Dot Commands Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add dot commands (`.model`, `.title`, `.session`) — an in-session configuration system triggered by typing `.` in the prompt. Server provides HTTP endpoints; the UI handles parsing, panel display, and submission.

**Architecture:** Server gains a `model` column on `sessions`, a `POST /bobai/command` endpoint, and a `GET /bobai/models` endpoint. The UI parses dot command input client-side, shows an inline panel above the textarea, fetches data via HTTP, and submits commands via POST. No LLM involvement.

**Tech Stack:** Bun, TypeScript, React 19, `bun:test`, Biome (tabs, 128-char lines).

**Design doc:** `docs/plans/2026-03-02-dot-commands-design.md`

---

### Task 1: Schema Migration — Add `model` Column to Sessions

**Files:**
- Modify: `packages/server/src/project.ts`
- Modify: `packages/server/test/helpers.ts`

**Step 1: Update test helper to include model column**

In `packages/server/test/helpers.ts`, add `model TEXT` to the sessions CREATE TABLE:

```typescript
export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT,
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
			sort_order INTEGER NOT NULL,
			metadata TEXT
		)
	`);
	db.exec("CREATE INDEX idx_messages_session ON messages(session_id, sort_order)");
	return db;
}
```

**Step 2: Add migration to project.ts**

In `packages/server/src/project.ts`, after the existing metadata migration block (lines 64-68), add:

```typescript
// Migrate: add model column to sessions if missing
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
if (!sessionColumns.some((c) => c.name === "model")) {
	db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
}
```

**Step 3: Run tests**

Run: `bun test packages/server/test/`
Expected: All existing tests pass (schema change is additive, no behavior change).

---

### Task 2: Repository — Session Model Read/Write + Update Title

**Files:**
- Modify: `packages/server/src/session/repository.ts`
- Create: `packages/server/test/dot-command.test.ts`

**Step 1: Write failing tests**

Create `packages/server/test/dot-command.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
```

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: FAIL — `updateSessionModel`, `updateSessionTitle` don't exist, `Session.model` doesn't exist.

**Step 2: Implement repository changes**

In `packages/server/src/session/repository.ts`:

1. Add `model` to `Session` interface:
```typescript
export interface Session {
	id: string;
	title: string | null;
	model: string | null;
	createdAt: string;
	updatedAt: string;
}
```

2. Add `model` to `SessionRow` type:
```typescript
type SessionRow = { id: string; title: string | null; model: string | null; created_at: string; updated_at: string };
```

3. Update `createSession` return to include `model: null`.

4. Update `getSession` to select and return `model`:
```typescript
export function getSession(db: Database, sessionId: string): Session | null {
	const row = db
		.prepare("SELECT id, title, model, created_at, updated_at FROM sessions WHERE id = ?")
		.get(sessionId) as SessionRow | null;

	if (!row) return null;
	return { id: row.id, title: row.title, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at };
}
```

5. Update `listSessions` similarly.

6. Add new functions:
```typescript
export function updateSessionModel(db: Database, sessionId: string, model: string): void {
	db.prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, new Date().toISOString(), sessionId);
}

export function updateSessionTitle(db: Database, sessionId: string, title: string): void {
	db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), sessionId);
}
```

**Step 3: Run tests**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS

Run: `bun test packages/server/test/`
Expected: All tests pass.

---

### Task 3: Command Handler + HTTP Endpoints

**Files:**
- Create: `packages/server/src/command.ts`
- Modify: `packages/server/src/server.ts`
- Add tests to: `packages/server/test/dot-command.test.ts`

**Step 1: Write failing tests for command handler**

Append to `packages/server/test/dot-command.test.ts`:

```typescript
import { handleCommand } from "../src/command";
import { CURATED_MODELS } from "../src/provider/copilot-models";

describe("handleCommand", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("model command updates session model", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "1", sessionId: session.id });
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated!.model).toBe(CURATED_MODELS[0]);
	});

	test("model command rejects invalid index", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "model", args: "99", sessionId: session.id });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Invalid model index");
	});

	test("model command rejects missing sessionId", () => {
		const result = handleCommand(db, { command: "model", args: "1" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("No session active");
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
		expect(result.error).toContain("Title cannot be empty");
	});

	test("session command returns not implemented", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "session", args: "", sessionId: session.id });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not implemented");
	});

	test("unknown command returns error", () => {
		const session = createSession(db, "system prompt");
		const result = handleCommand(db, { command: "foo", args: "", sessionId: session.id });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unknown command");
	});
});
```

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: FAIL — `handleCommand` doesn't exist.

**Step 2: Implement command.ts**

Create `packages/server/src/command.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { CURATED_MODELS } from "./provider/copilot-models";
import { getSession, updateSessionModel, updateSessionTitle } from "./session/repository";

export interface CommandRequest {
	command: string;
	args: string;
	sessionId?: string;
}

export type CommandResult = { ok: true } | { ok: false; error: string };

export function handleCommand(db: Database, req: CommandRequest): CommandResult {
	const { command, args, sessionId } = req;

	if (!sessionId) {
		return { ok: false, error: "No session active" };
	}

	const session = getSession(db, sessionId);
	if (!session) {
		return { ok: false, error: `Session not found: ${sessionId}` };
	}

	switch (command) {
		case "model":
			return handleModelCommand(db, sessionId, args);
		case "title":
			return handleTitleCommand(db, sessionId, args);
		case "session":
			return { ok: false, error: "Session switching is not implemented yet" };
		default:
			return { ok: false, error: `Unknown command: ${command}` };
	}
}

function handleModelCommand(db: Database, sessionId: string, args: string): CommandResult {
	const index = Number.parseInt(args, 10);
	if (Number.isNaN(index) || index < 1 || index > CURATED_MODELS.length) {
		return { ok: false, error: `Invalid model index: ${args}. Must be 1-${CURATED_MODELS.length}` };
	}
	const modelId = CURATED_MODELS[index - 1];
	updateSessionModel(db, sessionId, modelId);
	return { ok: true };
}

function handleTitleCommand(db: Database, sessionId: string, args: string): CommandResult {
	const title = args.trim();
	if (!title) {
		return { ok: false, error: "Title cannot be empty" };
	}
	updateSessionTitle(db, sessionId, title);
	return { ok: true };
}
```

**Step 3: Run tests**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS

**Step 4: Write failing tests for HTTP endpoints**

Append to `packages/server/test/dot-command.test.ts`:

```typescript
import { createServer } from "../src/server";

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

	test("GET /bobai/models returns curated model list", async () => {
		const res = await fetch(`${baseUrl}/bobai/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: { index: number; id: string; label: string }[] };
		expect(body.models.length).toBe(CURATED_MODELS.length);
		expect(body.models[0].index).toBe(1);
		expect(body.models[0].id).toBe(CURATED_MODELS[0]);
	});

	test("POST /bobai/command executes model command", async () => {
		// Create a session first
		const session = createSession(db, "system prompt");
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "1", sessionId: session.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
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
```

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: FAIL — endpoints don't exist yet.

**Step 5: Add HTTP endpoints to server.ts**

In `packages/server/src/server.ts`, add imports and routes:

1. Import: `import { handleCommand, type CommandRequest } from "./command";`
2. Import: `import { CURATED_MODELS } from "./provider/copilot-models";`

3. Add model label helper (inside the file or inline):
```typescript
function modelLabel(id: string): string {
	return id.replace(/^claude-/, "");
}
```

4. Add before the static file handler:
```typescript
if (url.pathname === "/bobai/models") {
	const models = CURATED_MODELS.map((id, i) => ({ index: i + 1, id, label: modelLabel(id) }));
	return Response.json({ models });
}

if (url.pathname === "/bobai/command" && req.method === "POST") {
	if (!options.db) {
		return Response.json({ ok: false, error: "Database not available" });
	}
	const body = (await req.json()) as CommandRequest;
	const result = handleCommand(options.db, body);
	return Response.json(result);
}
```

**Step 6: Run tests**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS

Run: `bun test packages/server/test/`
Expected: All tests pass.

---

### Task 4: Handler Uses Session Model

**Files:**
- Modify: `packages/server/src/handler.ts`
- Modify: `packages/server/src/protocol.ts`
- Add tests to: `packages/server/test/dot-command.test.ts`

**Step 1: Write failing test**

Append to `packages/server/test/dot-command.test.ts`:

```typescript
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { updateSessionModel } from "../src/session/repository";

describe("handlePrompt respects session model", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("uses session model when set", async () => {
		// Create a session and set its model
		const session = createSession(db, "system prompt");
		updateSessionModel(db, session.id, "claude-sonnet-4.6");

		// Provider that captures options
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
		const ws = { send(msg: string) { sent.push(msg); } };

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
		const ws = { send(msg: string) { sent.push(msg); } };

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		expect(captured[0].model).toBe("gpt-5-mini");
	});

	test("done message includes session model", async () => {
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
		const ws = { send(msg: string) { sent.push(msg); } };

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		const msgs = sent.map(s => JSON.parse(s));
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
		const ws = { send(msg: string) { sent.push(msg); } };

		await handlePrompt({ ws, db, provider, model: "gpt-5-mini", text: "hello", sessionId: session.id, projectRoot: "/tmp" });

		const msgs = sent.map(s => JSON.parse(s));
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.title).toBe("Test Title");
	});
});
```

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: FAIL — handler doesn't read session model or send title in done.

**Step 2: Modify handler.ts**

In `packages/server/src/handler.ts`:

1. After resolving/creating the session, read the session object to get its model:

```typescript
// After line 40 (currentSessionId = sessionId):
const sessionObj = getSession(db, sessionId);
// ...later use sessionObj.model and sessionObj.title
```

For new sessions, `sessionObj.model` is null.

2. Determine effective model:
```typescript
const effectiveModel = sessionObj?.model ?? model;
```

3. Pass `effectiveModel` to `runAgentLoop` and to the `done` message.

4. Update protocol.ts — add optional `title` to the `done` message:
```typescript
| { type: "done"; sessionId: string; model: string; title?: string | null }
```

5. Send title in done:
```typescript
send(ws, { type: "done", sessionId: currentSessionId, model: effectiveModel, title: sessionObj?.title ?? null });
```

**Step 3: Run tests**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS

Run: `bun test packages/server/test/`
Expected: All tests pass.

---

### Task 5: UI — Dot Command Panel and State Machine

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/useWebSocket.ts`
- Modify: `packages/ui/src/styles/app.css`

This task modifies the UI to add the dot command panel. Since the UI doesn't have automated tests, verify by building and visually inspecting.

**Step 1: Update useWebSocket.ts**

1. Add `title` to the `done` handler's ServerMessage type:
```typescript
| { type: "done"; sessionId: string; model: string; title?: string | null }
```

2. Add `title` state:
```typescript
const [title, setTitle] = useState<string | null>(null);
```

3. In the `done` handler, set title:
```typescript
if (msg.type === "done") {
	sessionId.current = msg.sessionId;
	setModel(msg.model);
	setTitle(msg.title ?? null);
	// ... rest unchanged
}
```

4. Expose `sessionId` (as a getter), `title`, and `setModel`/`setTitle` from the hook:
```typescript
return { messages, connected, isStreaming, sendPrompt, newChat, model, setModel, title, setTitle, status, getSessionId: () => sessionId.current };
```

**Step 2: Add dot command panel to App.tsx**

1. Define dot command types and the known commands:
```typescript
const DOT_COMMANDS = ["model", "session", "title"] as const;
```

2. Add state for model list cache:
```typescript
const [modelList, setModelList] = useState<{ index: number; id: string; label: string }[] | null>(null);
```

3. Derive dot command state from `input`:
```typescript
function parseDotInput(text: string) {
	if (!text.startsWith(".")) return null;
	const withoutDot = text.slice(1);
	const spaceIndex = withoutDot.indexOf(" ");
	if (spaceIndex === -1) {
		// COMMAND_SELECT mode
		const prefix = withoutDot.toLowerCase();
		const matches = DOT_COMMANDS.filter((c) => c.startsWith(prefix));
		return { mode: "select" as const, prefix, matches, args: "" };
	}
	// Check if command is unambiguous
	const cmdPart = withoutDot.slice(0, spaceIndex).toLowerCase();
	const matches = DOT_COMMANDS.filter((c) => c.startsWith(cmdPart));
	if (matches.length === 1) {
		return { mode: "args" as const, prefix: cmdPart, matches, args: withoutDot.slice(spaceIndex + 1), command: matches[0] };
	}
	// Ambiguous even with space — treat as select
	return { mode: "select" as const, prefix: cmdPart, matches, args: "" };
}
```

4. Fetch models when entering COMMAND_ARGS for model:
```typescript
// In a useEffect, fetch models when needed
useEffect(() => {
	const parsed = parseDotInput(input);
	if (parsed?.mode === "args" && parsed.command === "model" && !modelList) {
		fetch("/bobai/models")
			.then((res) => res.json())
			.then((data) => setModelList(data.models))
			.catch(() => {});
	}
}, [input, modelList]);
```

5. Render dot command panel between messages and prompt:
```typescript
function renderDotPanel() {
	const parsed = parseDotInput(input);
	if (!parsed) return null;

	if (parsed.mode === "select") {
		return (
			<div className="panel panel--tool">
				{parsed.matches.length > 0
					? parsed.matches.map((cmd) => <div key={cmd}>{cmd}</div>)
					: <div>No matching commands</div>}
			</div>
		);
	}

	if (parsed.command === "model") {
		if (!modelList) return <div className="panel panel--tool">Loading models...</div>;
		const filtered = parsed.args
			? modelList.filter((m) => String(m.index).startsWith(parsed.args.trim()))
			: modelList;
		return (
			<div className="panel panel--tool">
				{filtered.length > 0
					? filtered.map((m) => <div key={m.id}>{m.index}: {m.label}</div>)
					: <div>No matching models</div>}
			</div>
		);
	}

	if (parsed.command === "title") {
		const titleText = parsed.args.trim();
		return (
			<div className="panel panel--tool">
				{titleText ? `Set session title: ${titleText}` : "Enter session title"}
			</div>
		);
	}

	if (parsed.command === "session") {
		return <div className="panel panel--tool">Session switching is not implemented yet</div>;
	}

	return null;
}
```

6. Modify submit to handle dot commands:
```typescript
function submit() {
	const text = input.trim();
	if (!text || !connected) return;

	const parsed = parseDotInput(text);
	if (parsed?.mode === "args" && parsed.command) {
		// Dot command submission
		const sid = getSessionId();
		fetch("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: parsed.command, args: parsed.args.trim(), sessionId: sid }),
		})
			.then((res) => res.json())
			.then((result) => {
				if (result.ok) {
					if (parsed.command === "model" && modelList) {
						const idx = Number.parseInt(parsed.args.trim(), 10);
						const selected = modelList.find((m) => m.index === idx);
						if (selected) setModel(selected.id);
					}
					if (parsed.command === "title") {
						setTitle(parsed.args.trim());
					}
				}
			})
			.catch(() => {});
		setInput("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
		return;
	}

	if (isStreaming) return;
	autoScroll.current = true;
	sendPrompt(text);
	setInput("");
	setHistoryIndex(-1);
	if (textareaRef.current) textareaRef.current.style.height = "auto";
}
```

7. Add dot panel in the JSX between messages and prompt:
```jsx
{renderDotPanel()}
```

**Step 3: Add title to status bar**

In the status bar JSX:
```jsx
<div className="panel panel--status-bar">
	<span>
		<span className="status-bar-label">Bob AI</span> <span className={`status-dot${connected ? "" : " disconnected"}`} />
		{" "}{connected ? "connected" : "connecting..."}
		{title && <span className="status-bar-title"> {title}</span>}
	</span>
	<span>{status}</span>
</div>
```

**Step 4: Add CSS for status bar title**

In `packages/ui/src/styles/app.css`:
```css
.status-bar-title {
	color: var(--text-primary);
}
```

**Step 5: Build and verify**

Run: `bun run build` from `packages/ui/`
Expected: Build succeeds.

Run: `bunx biome check src/` from `packages/ui/`
Expected: No errors.

---

### Task 6: Run All Tests and Biome Check

**Step 1: Run all server tests**

Run: `bun test packages/server/test/`
Expected: All tests pass.

**Step 2: Run biome on server**

Run: `bunx biome check src/` from `packages/server/`
Expected: No new errors (pre-existing warnings are acceptable).

**Step 3: Run biome on UI**

Run: `bunx biome check src/` from `packages/ui/`
Expected: No new errors.
