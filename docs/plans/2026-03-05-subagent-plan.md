# Subagent Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a `task` tool that lets the primary agent spawn child agent sessions, each running its own agent loop and returning results to the parent.

**Architecture:** Factory-function pattern — `createTaskTool(deps)` captures DB, provider, WS, and signal via closure so `ToolContext` stays unchanged. Child sessions get all tools except `task` (no recursion). WebSocket events from children are tagged with `sessionId` for UI routing. The in-memory `SubagentStatus` map tracks running/done state.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), WebSocket

**Design doc:** `docs/plans/2026-03-05-subagent-design.md`

---

## Task 1: Schema Migration — `parent_id` Column

**Files:**
- Modify: `packages/server/src/project.ts:70-74` (add migration block)
- Modify: `packages/server/test/helpers.ts:6-12` (add column to CREATE TABLE)

**Step 1: Write the failing test**

Add a test that inserts a session with `parent_id` and reads it back. This verifies the column exists.

Create file: `packages/server/test/subagent-schema.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers";

describe("subagent schema", () => {
	test("sessions table has parent_id column", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const parentId = crypto.randomUUID();
		const now = new Date().toISOString();

		// Insert parent session first
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(parentId, null, now, now);
		// Insert child session with parent_id
		db.prepare("INSERT INTO sessions (id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			id,
			"child",
			parentId,
			now,
			now,
		);

		const row = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(id) as { parent_id: string };
		expect(row.parent_id).toBe(parentId);
		db.close();
	});

	test("parent_id is nullable", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);

		const row = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(id) as { parent_id: string | null };
		expect(row.parent_id).toBeNull();
		db.close();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/subagent-schema.test.ts`
Expected: FAIL — `parent_id` column doesn't exist in `createTestDb`.

**Step 3: Add `parent_id` to `createTestDb`**

In `packages/server/test/helpers.ts`, add `parent_id TEXT` to the sessions CREATE TABLE:

```typescript
export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT,
			parent_id TEXT REFERENCES sessions(id),
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

**Step 4: Add migration to `project.ts`**

In `packages/server/src/project.ts`, after the existing model migration (line 74), add:

```typescript
// Migrate: add parent_id column to sessions if missing (subagent support)
if (!sessionColumns.some((c) => c.name === "parent_id")) {
	db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id)");
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/server/test/subagent-schema.test.ts`
Expected: PASS

Run: `bun test packages/server/test/repository.test.ts`
Expected: PASS (existing tests unaffected)

**Step 6: Commit**

```
feat: add parent_id column to sessions table for subagent support
```

---

## Task 2: Repository Functions — `createSubagentSession` and `listSubagentSessions`

**Files:**
- Modify: `packages/server/src/session/repository.ts` (add two functions + update `Session` interface)
- Modify: `packages/server/test/repository.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to end of `packages/server/test/repository.test.ts`:

```typescript
import { createSubagentSession, listSubagentSessions } from "../src/session/repository";

// Inside the existing describe("session repository", () => { ... }):

test("createSubagentSession creates a session with parent_id and system prompt", () => {
	const parent = createSession(db, "sys");
	const child = createSubagentSession(db, parent.id, "Exploring codebase", "gpt-5-mini", "You are a subagent.");
	expect(child.id).toBeTruthy();
	expect(child.title).toBe("Exploring codebase");
	expect(child.parentId).toBe(parent.id);

	// Should have system prompt as first message
	const messages = getMessages(db, child.id);
	expect(messages).toHaveLength(1);
	expect(messages[0].role).toBe("system");
	expect(messages[0].content).toBe("You are a subagent.");
});

test("listSubagentSessions returns only subagent sessions ordered by updated_at", () => {
	const freshDb = createTestDb();
	const parent = createSession(freshDb, "sys");
	const c1 = createSubagentSession(freshDb, parent.id, "Task A", "gpt-5-mini", "sys");
	appendMessage(freshDb, c1.id, "user", "bump"); // bump c1's updated_at
	const c2 = createSubagentSession(freshDb, parent.id, "Task B", "gpt-5-mini", "sys");

	const subagents = listSubagentSessions(freshDb, 5);
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
	const parent = createSession(freshDb, "sys");
	createSubagentSession(freshDb, parent.id, "A", "m", "sys");
	createSubagentSession(freshDb, parent.id, "B", "m", "sys");
	createSubagentSession(freshDb, parent.id, "C", "m", "sys");

	const subagents = listSubagentSessions(freshDb, 2);
	expect(subagents).toHaveLength(2);
	freshDb.close();
});

test("listSubagentSessions does not return regular sessions", () => {
	const freshDb = createTestDb();
	createSession(freshDb, "sys"); // regular session, no parent_id
	const subagents = listSubagentSessions(freshDb);
	expect(subagents).toHaveLength(0);
	freshDb.close();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/repository.test.ts`
Expected: FAIL — `createSubagentSession` and `listSubagentSessions` don't exist.

**Step 3: Implement the functions**

In `packages/server/src/session/repository.ts`:

Update the `Session` interface to include `parentId`:

```typescript
export interface Session {
	id: string;
	title: string | null;
	model: string | null;
	parentId: string | null;
	createdAt: string;
	updatedAt: string;
}
```

Update `SessionRow` type:

```typescript
type SessionRow = {
	id: string;
	title: string | null;
	model: string | null;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
};
```

Update `createSession` return to include `parentId: null`.

Update `getSession` to select and map `parent_id`.

Update `listSessions` to select and map `parent_id`.

Add the two new functions:

```typescript
export function createSubagentSession(
	db: Database,
	parentId: string,
	title: string,
	model: string,
	systemPrompt: string,
): Session & { parentId: string } {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.transaction(() => {
		db.prepare(
			"INSERT INTO sessions (id, title, model, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, title, model, parentId, now, now);
		db.prepare(
			"INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
		).run(crypto.randomUUID(), id, "system", systemPrompt, now, 0);
	})();

	return { id, title, model, parentId, createdAt: now, updatedAt: now };
}

export function listSubagentSessions(db: Database, limit = 5): Session[] {
	const rows = db
		.prepare(
			"SELECT id, title, model, parent_id, created_at, updated_at FROM sessions WHERE parent_id IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?",
		)
		.all(limit) as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		parentId: r.parent_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}
```

**Important:** All existing functions that return `Session` must now include `parentId`. Update:
- `createSession`: add `parentId: null` to return.
- `getSession`: add `parent_id` to SELECT, map to `parentId`.
- `listSessions`: add `parent_id` to SELECT, map to `parentId`.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/repository.test.ts`
Expected: PASS

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS (uses Session interface)

Run: `bun test packages/server/test/handler.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add createSubagentSession and listSubagentSessions repository functions
```

---

## Task 3: Protocol Changes — `sessionId` on Messages + New Types

**Files:**
- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/test/protocol.test.ts`

**Step 1: Write the failing tests**

Add to `packages/server/test/protocol.test.ts`:

```typescript
test("send token with sessionId includes it in output", () => {
	const ws = mockWs();
	send(ws, { type: "token", text: "hello", sessionId: "child-1" });
	expect(ws.messages()[0]).toEqual({ type: "token", text: "hello", sessionId: "child-1" });
});

test("send subagent_start message", () => {
	const ws = mockWs();
	send(ws, { type: "subagent_start", sessionId: "child-1", title: "Exploring code" });
	expect(ws.messages()[0]).toEqual({ type: "subagent_start", sessionId: "child-1", title: "Exploring code" });
});

test("send subagent_done message", () => {
	const ws = mockWs();
	send(ws, { type: "subagent_done", sessionId: "child-1" });
	expect(ws.messages()[0]).toEqual({ type: "subagent_done", sessionId: "child-1" });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/protocol.test.ts`
Expected: FAIL — TypeScript errors, `subagent_start` and `subagent_done` types don't exist.

**Step 3: Implement**

Update `packages/server/src/protocol.ts`:

```typescript
// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "subagent_start"; sessionId: string; title: string }
	| { type: "subagent_done"; sessionId: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/protocol.test.ts`
Expected: PASS

Run: `bun test` (full suite — the `sessionId?: string` is additive, shouldn't break anything)
Expected: PASS

**Step 5: Commit**

```
feat: add sessionId to ServerMessage variants and subagent_start/done types
```

---

## Task 4: Agent Loop Changes — `signal` and `initiator`

**Files:**
- Modify: `packages/server/src/agent-loop.ts:12-21` (add `signal` and `initiator` to `AgentLoopOptions`)
- Modify: `packages/server/src/agent-loop.ts:44-48` (forward to `provider.stream()`)
- Modify: `packages/server/test/agent-loop.test.ts`

**Step 1: Write the failing tests**

Add to `packages/server/test/agent-loop.test.ts`:

```typescript
test("forwards signal and initiator to provider.stream()", async () => {
	const captured: ProviderOptions[] = [];
	const controller = new AbortController();
	const provider: Provider = {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			captured.push(opts);
			yield { type: "text", text: "ok" };
			yield { type: "finish", reason: "stop" };
		},
	};

	await runAgentLoop({
		provider,
		model: "test",
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		],
		tools: createToolRegistry([]),
		projectRoot: "/tmp",
		signal: controller.signal,
		initiator: "agent",
		onEvent() {},
		onMessage() {},
	});

	expect(captured[0].signal).toBe(controller.signal);
	expect(captured[0].initiator).toBe("agent");
});

test("signal and initiator default to undefined when not provided", async () => {
	const captured: ProviderOptions[] = [];
	const provider: Provider = {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			captured.push(opts);
			yield { type: "text", text: "ok" };
			yield { type: "finish", reason: "stop" };
		},
	};

	await runAgentLoop({
		provider,
		model: "test",
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		],
		tools: createToolRegistry([]),
		projectRoot: "/tmp",
		onEvent() {},
		onMessage() {},
	});

	expect(captured[0].signal).toBeUndefined();
	expect(captured[0].initiator).toBeUndefined();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: FAIL — `signal` and `initiator` not recognized in `AgentLoopOptions`.

**Step 3: Implement**

In `packages/server/src/agent-loop.ts`:

Add to `AgentLoopOptions`:

```typescript
export interface AgentLoopOptions {
	provider: Provider;
	model: string;
	messages: Message[];
	tools: ToolRegistry;
	projectRoot: string;
	maxIterations?: number;
	signal?: AbortSignal;
	initiator?: "user" | "agent";
	onEvent: (event: AgentEvent) => void;
	onMessage: (msg: Message) => void;
}
```

In `runAgentLoop`, destructure the new fields:

```typescript
const { provider, model, tools, projectRoot, onEvent, onMessage, signal, initiator } = options;
```

Update the `provider.stream()` call (line 44) to forward:

```typescript
for await (const event of provider.stream({
	model,
	messages: conversation,
	tools: tools.definitions.length > 0 ? tools.definitions : undefined,
	signal,
	initiator,
})) {
```

Also update the final tool-free call (line 152) to forward signal:

```typescript
for await (const event of provider.stream({ model, messages: conversation, signal })) {
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: PASS

Run: `bun test packages/server/test/handler.test.ts`
Expected: PASS (handler doesn't pass signal/initiator yet, defaults work)

**Step 5: Commit**

```
feat: add signal and initiator passthrough to agent loop
```

---

## Task 5: Subagent Status Tracker

**Files:**
- Create: `packages/server/src/subagent-status.ts`
- Create: `packages/server/test/subagent-status.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/subagent-status.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { SubagentStatus } from "../src/subagent-status";

describe("SubagentStatus", () => {
	test("set and get status", () => {
		const tracker = new SubagentStatus();
		tracker.set("session-1", "running");
		expect(tracker.get("session-1")).toBe("running");
	});

	test("get returns undefined for unknown session", () => {
		const tracker = new SubagentStatus();
		expect(tracker.get("unknown")).toBeUndefined();
	});

	test("set updates existing status", () => {
		const tracker = new SubagentStatus();
		tracker.set("session-1", "running");
		tracker.set("session-1", "done");
		expect(tracker.get("session-1")).toBe("done");
	});

	test("getAll returns all entries", () => {
		const tracker = new SubagentStatus();
		tracker.set("s1", "running");
		tracker.set("s2", "done");
		const all = tracker.getAll();
		expect(all).toEqual(
			new Map([
				["s1", "running"],
				["s2", "done"],
			]),
		);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/subagent-status.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `packages/server/src/subagent-status.ts`:

```typescript
export class SubagentStatus {
	private statuses = new Map<string, "running" | "done">();

	set(sessionId: string, status: "running" | "done"): void {
		this.statuses.set(sessionId, status);
	}

	get(sessionId: string): "running" | "done" | undefined {
		return this.statuses.get(sessionId);
	}

	getAll(): Map<string, "running" | "done"> {
		return new Map(this.statuses);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/subagent-status.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add in-memory SubagentStatus tracker
```

---

## Task 6: Task Tool — Factory Function

This is the largest task. The `createTaskTool` factory captures all dependencies via closure.

**Files:**
- Create: `packages/server/src/tool/task.ts`
- Create: `packages/server/test/task-tool.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/task-tool.test.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent-loop";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { getMessages, listSubagentSessions } from "../src/session/repository";
import { SubagentStatus } from "../src/subagent-status";
import { createTaskTool } from "../src/tool/task";
import type { Tool } from "../src/tool/tool";
import { createTestDb } from "./helpers";

// Minimal mock provider: first call yields text, done.
function textOnlyProvider(text: string): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text };
			yield { type: "finish", reason: "stop" };
		},
	};
}

// Title-generating provider: returns a short title when messages has a single user message starting with "Generate"
function titleAndAgentProvider(titleText: string, agentText: string): Provider {
	let callCount = 0;
	return {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			// First call is title generation (single user message with "Generate" prefix)
			const lastMsg = opts.messages[opts.messages.length - 1];
			if (callCount === 1 && lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
				yield { type: "text", text: titleText };
				yield { type: "finish", reason: "stop" };
				return;
			}
			// Agent loop call
			yield { type: "text", text: agentText };
			yield { type: "finish", reason: "stop" };
		},
	};
}

describe("createTaskTool", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("returns a Tool with correct definition", () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId: "parent-1",
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});
		expect(tool.definition.function.name).toBe("task");
		expect(tool.definition.function.parameters).toBeTruthy();
	});

	test("executes and creates a child session", async () => {
		const events: AgentEvent[] = [];
		const status = new SubagentStatus();
		const tool = createTaskTool({
			db,
			provider: titleAndAgentProvider("Code explorer", "I found 3 files."),
			model: "test-model",
			parentSessionId: "parent-1",
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: (e) => events.push(e),
			subagentStatus: status,
		});

		const result = await tool.execute(
			{ description: "Explore the codebase", prompt: "Find all TypeScript files" },
			{ projectRoot: "/tmp" },
		);

		// Result should contain the agent's final text
		expect(result.llmOutput).toContain("I found 3 files.");
		expect(result.llmOutput).toContain("task_id");

		// Should have created a subagent session
		const subagents = listSubagentSessions(db);
		expect(subagents.length).toBeGreaterThanOrEqual(1);

		// Status should be "done"
		const latestSubagent = subagents[0];
		expect(status.get(latestSubagent.id)).toBe("done");
	});

	test("uses description as title fallback on title generation failure", async () => {
		// Provider that throws on first call (title gen) and succeeds on agent call
		let callCount = 0;
		const failTitleProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					throw new Error("title gen failed");
				}
				yield { type: "text", text: "result" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const tool = createTaskTool({
			db,
			provider: failTitleProvider,
			model: "test-model",
			parentSessionId: "parent-1",
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute(
			{ description: "My fallback title", prompt: "do something" },
			{ projectRoot: "/tmp" },
		);

		expect(result.llmOutput).toContain("result");
	});

	test("formatCall returns description", () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId: "parent-1",
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const output = tool.formatCall({ description: "Explore codebase", prompt: "find files" });
		expect(output).toContain("Explore codebase");
	});

	test("child session has system prompt and task prompt as messages", async () => {
		const tool = createTaskTool({
			db,
			provider: titleAndAgentProvider("title", "done"),
			model: "test-model",
			parentSessionId: "parent-1",
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		await tool.execute(
			{ description: "Test task", prompt: "Do the thing" },
			{ projectRoot: "/tmp" },
		);

		// Find the child session
		const subagents = listSubagentSessions(db);
		const child = subagents[0];
		const messages = getMessages(db, child.id);

		// Should have: system + user(prompt) + assistant(result)
		expect(messages.length).toBeGreaterThanOrEqual(3);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("You are a subagent.");
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toBe("Do the thing");
		expect(messages[1].metadata).toEqual({ source: "agent", parentSessionId: "parent-1" });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/task-tool.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `packages/server/src/tool/task.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { AgentEvent } from "../agent-loop";
import { runAgentLoop } from "../agent-loop";
import type { Provider, Message } from "../provider/provider";
import { appendMessage, createSubagentSession, getMessages } from "../session/repository";
import type { SubagentStatus } from "../subagent-status";
import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { grepSearchTool } from "./grep-search";
import { listDirectoryTool } from "./list-directory";
import { readFileTool } from "./read-file";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { createToolRegistry } from "./tool";
import { writeFileTool } from "./write-file";

export interface TaskToolDeps {
	db: Database;
	provider: Provider;
	model: string;
	parentSessionId: string;
	projectRoot: string;
	systemPrompt: string;
	signal?: AbortSignal;
	onEvent: (event: AgentEvent & { sessionId?: string }) => void;
	subagentStatus: SubagentStatus;
}

async function generateTitle(provider: Provider, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
	const messages: Message[] = [
		{
			role: "user",
			content: `Generate a short title (3-8 words) for this task. Return ONLY the title, nothing else.\n\nTask: ${prompt}`,
		},
	];

	let title = "";
	for await (const event of provider.stream({ model, messages, signal })) {
		if (event.type === "text") {
			title += event.text;
		}
	}
	return title.trim().replace(/^["']|["']$/g, "");
}

export function createTaskTool(deps: TaskToolDeps): Tool {
	const { db, provider, model, parentSessionId, projectRoot, systemPrompt, signal, onEvent, subagentStatus } = deps;

	return {
		definition: {
			type: "function",
			function: {
				name: "task",
				description:
					"Launch a subagent to handle a complex, multi-step task autonomously. " +
					"The subagent runs its own agent loop with full tool access (except task). " +
					"For exploratory/read-only tasks, instruct the subagent to avoid edit_file and write_file. " +
					"Each subagent starts fresh — include all necessary context in the prompt. " +
					"Returns the subagent's final response text and a task_id for potential resumption.",
				parameters: {
					type: "object",
					properties: {
						description: {
							type: "string",
							description: "Short task description (up to 20 words)",
						},
						prompt: {
							type: "string",
							description: "Full instructions for the subagent including all necessary context",
						},
						task_id: {
							type: "string",
							description: "Resume a previous subagent session (optional)",
						},
					},
					required: ["description", "prompt"],
				},
			},
		},
		mergeable: false,
		formatCall(args: Record<string, unknown>): string {
			return `**Subagent** ${args.description ?? "task"}`;
		},
		async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
			const description = args.description as string;
			const prompt = args.prompt as string;
			const taskId = args.task_id as string | undefined;

			let childSessionId: string;

			if (taskId) {
				// Resume existing session
				childSessionId = taskId;
			} else {
				// Generate title (use gpt-5-mini for speed, fall back to description)
				let title: string;
				try {
					title = await generateTitle(provider, "gpt-5-mini", prompt, signal);
					if (!title) title = description;
				} catch {
					title = description;
				}

				// Create child session
				const child = createSubagentSession(db, parentSessionId, title, model, systemPrompt);
				childSessionId = child.id;

				// Add the task prompt as a user message with agent metadata
				appendMessage(db, childSessionId, "user", prompt, {
					source: "agent",
					parentSessionId,
				});
			}

			// Notify UI
			subagentStatus.set(childSessionId, "running");
			onEvent({ type: "status", text: `Subagent started`, sessionId: childSessionId });

			// Load child session messages
			const stored = getMessages(db, childSessionId);
			const messages: Message[] = stored.map((m) => {
				if (m.role === "tool" && m.metadata?.tool_call_id) {
					return { role: "tool", content: m.content, tool_call_id: m.metadata.tool_call_id as string };
				}
				if (m.role === "assistant" && m.metadata?.tool_calls) {
					return {
						role: "assistant",
						content: m.content || null,
						tool_calls: m.metadata.tool_calls as import("../provider/provider").AssistantMessage["tool_calls"],
					};
				}
				return { role: m.role as "system" | "user" | "assistant", content: m.content };
			});

			// Build tool registry without the task tool itself (no recursion)
			const childTools = createToolRegistry([
				readFileTool,
				listDirectoryTool,
				writeFileTool,
				editFileTool,
				grepSearchTool,
				bashTool,
			]);

			// Run agent loop
			const newMessages = await runAgentLoop({
				provider,
				model,
				messages,
				tools: childTools,
				projectRoot,
				signal,
				initiator: "agent",
				onEvent(event: AgentEvent) {
					onEvent({ ...event, sessionId: childSessionId });
				},
				onMessage(msg) {
					if (msg.role === "assistant") {
						const metadata = msg.tool_calls ? { tool_calls: msg.tool_calls } : undefined;
						appendMessage(db, childSessionId, "assistant", msg.content ?? "", metadata);
					} else if (msg.role === "tool") {
						appendMessage(db, childSessionId, "tool", msg.content, { tool_call_id: msg.tool_call_id });
					}
				},
			});

			subagentStatus.set(childSessionId, "done");

			// Extract final assistant text
			const lastAssistant = [...newMessages].reverse().find((m) => m.role === "assistant" && !("tool_calls" in m));
			const resultText = lastAssistant ? (lastAssistant as { content: string }).content : "(subagent produced no text output)";

			const llmOutput = `${resultText}\n\n[task_id: ${childSessionId}]`;

			return {
				llmOutput,
				uiOutput: null,
				mergeable: false,
			};
		},
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/task-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add task tool for spawning subagent sessions
```

---

## Task 7: Handler Wiring — Register Task Tool + WebSocket Events

**Files:**
- Modify: `packages/server/src/handler.ts`
- Modify: `packages/server/test/handler.test.ts`

**Step 1: Write the failing test**

Add to `packages/server/test/handler.test.ts`:

```typescript
test("task tool is available in tool registry (subagent spawning)", async () => {
	// Provider that requests the "task" tool call
	let callCount = 0;
	const taskProvider: Provider = {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			if (callCount === 1) {
				// LLM tries to call the "task" tool
				yield { type: "tool_call_start", index: 0, id: "call_task", name: "task" };
				yield {
					type: "tool_call_delta",
					index: 0,
					arguments: JSON.stringify({
						description: "Test subagent",
						prompt: "Say hello",
					}),
				};
				yield { type: "finish", reason: "tool_calls" };
			} else if (callCount <= 3) {
				// Subagent title gen + agent loop calls
				yield { type: "text", text: "Hello from subagent" };
				yield { type: "finish", reason: "stop" };
			} else {
				// Parent continues
				yield { type: "text", text: "Subagent completed" };
				yield { type: "finish", reason: "stop" };
			}
		},
	};

	const ws = mockWs();
	await handlePrompt({ ws, db, provider: taskProvider, model: "test-model", text: "use subagent", projectRoot: "/tmp" });

	const msgs = ws.messages();
	// Should have a tool_call event for the task tool (not "Unknown tool")
	const toolCall = msgs.find((m: { type: string; id?: string }) => m.type === "tool_call" && m.id === "call_task");
	expect(toolCall).toBeTruthy();
	expect(toolCall.output).toContain("Subagent");

	// Should have a tool_result (not an "Unknown tool" error)
	const toolResult = msgs.find((m: { type: string; id?: string }) => m.type === "tool_result" && m.id === "call_task");
	expect(toolResult).toBeTruthy();

	// Should complete with done
	expect(msgs.at(-1).type).toBe("done");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/handler.test.ts`
Expected: FAIL — task tool not registered, result will say "Unknown tool: task".

**Step 3: Implement**

Update `packages/server/src/handler.ts`:

1. Import the new modules:

```typescript
import { SubagentStatus } from "./subagent-status";
import { createTaskTool } from "./tool/task";
import { send as protocolSend } from "./protocol";
```

2. Add `subagentStatus` field to `PromptRequest` (or create it inside `handlePrompt`):

Since the status tracker should be shared across the server lifetime, add it as an optional field to `PromptRequest`. For simplicity (and because it's only used during a single prompt execution in this phase), create it locally. We'll refactor later if needed.

Actually, per the design doc, we create one `SubagentStatus` per server. But for the handler, we'll pass it through. For now, create a module-level instance:

In `handler.ts`, at module level:
```typescript
const subagentStatus = new SubagentStatus();
```

3. In `handlePrompt`, create the task tool and add it to the registry:

```typescript
const taskTool = createTaskTool({
	db,
	provider,
	model: effectiveModel,
	parentSessionId: currentSessionId,
	projectRoot,
	systemPrompt: SYSTEM_PROMPT,
	onEvent(event) {
		if (event.type === "text") {
			send(ws, { type: "token", text: event.text, sessionId: event.sessionId });
		} else if (event.type === "tool_call") {
			send(ws, { type: "tool_call", id: event.id, output: event.output, sessionId: event.sessionId });
		} else if (event.type === "tool_result") {
			send(ws, { type: "tool_result", id: event.id, output: event.output, mergeable: event.mergeable, sessionId: event.sessionId });
		} else if (event.type === "status") {
			send(ws, { type: "status", text: event.text, sessionId: event.sessionId });
		}
	},
	subagentStatus,
});

const tools = createToolRegistry([readFileTool, listDirectoryTool, writeFileTool, editFileTool, grepSearchTool, bashTool, taskTool]);
```

Note: The `onEvent` in `createTaskTool` already adds `sessionId` to events. The existing `onEvent` in `runAgentLoop` (for parent events) doesn't set `sessionId`, which is correct — parent events have no `sessionId`.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/handler.test.ts`
Expected: PASS

Run: `bun test` (full suite)
Expected: PASS

**Step 5: Commit**

```
feat: wire task tool into handlePrompt with subagent event routing
```

---

## Task 8: System Prompt Update

**Files:**
- Modify: `packages/server/src/system-prompt.ts`
- Modify: `packages/server/test/system-prompt.test.ts` (verify task tool is mentioned)

**Step 1: Write the failing test**

Add to `packages/server/test/system-prompt.test.ts`:

```typescript
test("system prompt mentions task tool", () => {
	expect(SYSTEM_PROMPT).toContain("task");
	expect(SYSTEM_PROMPT).toContain("subagent");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: FAIL — "task" and "subagent" not in system prompt.

**Step 3: Implement**

Update `packages/server/src/system-prompt.ts` to add the task tool description:

```typescript
export const SYSTEM_PROMPT = `You are Bob AI, a coding assistant.

You help developers write, understand, debug, and improve code. You give clear, direct answers. When a question is ambiguous, you ask for clarification rather than guess.

You have access to the following tools:

- read_file: Read the contents of a file.
- list_directory: List the contents of a directory.
- write_file: Create or overwrite a file. Parent directories are created automatically.
- edit_file: Edit a file by replacing an exact string with new content. The old_string must match exactly one location.
- grep_search: Search file contents for a pattern. Returns matching lines with paths and line numbers.
- bash: Execute a bash command in the project directory. Use for running tests, builds, linters, git, and other shell operations.
- task: Launch a subagent to handle complex, multi-step tasks autonomously. Each subagent runs independently with its own tool access (except task). Use for tasks that can run in isolation — exploring code, researching patterns, or implementing discrete features. For exploratory/read-only tasks, instruct the subagent to avoid edit_file and write_file.

When working with code:
- Use grep_search to find relevant code before reading entire files.
- Read files to understand context before making changes.
- Use edit_file for modifying existing files and write_file for creating new ones.
- After making changes, run relevant tests or builds to verify correctness.
- Use the task tool for complex multi-step work that can be delegated to a subagent.`;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add task tool to system prompt
```

---

## Task 9: `.subagent` Dot Command + HTTP Endpoint

**Files:**
- Modify: `packages/server/src/command.ts` (add "subagent" case)
- Modify: `packages/server/src/server.ts` (add GET /bobai/subagents endpoint)
- Modify: `packages/server/test/dot-command.test.ts`

**Step 1: Write the failing tests**

Add to `packages/server/test/dot-command.test.ts`:

```typescript
import { createSubagentSession, listSubagentSessions } from "../src/session/repository";

// In the "handleCommand" describe block:
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
```

Also add HTTP endpoint test in "HTTP endpoints" describe:

```typescript
test("GET /bobai/subagents returns recent subagent sessions", async () => {
	const parent = createSession(db, "sys");
	createSubagentSession(db, parent.id, "HTTP Task A", "gpt-5-mini", "sys");

	const res = await fetch(`${baseUrl}/bobai/subagents`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { index: number; title: string; sessionId: string }[];
	expect(body.length).toBeGreaterThanOrEqual(1);
	expect(body[0].title).toBeTruthy();
	expect(body[0].sessionId).toBeTruthy();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: FAIL — "subagent" is an unknown command.

**Step 3: Implement**

In `packages/server/src/command.ts`:

Add import:
```typescript
import { listSubagentSessions } from "./session/repository";
```

Add case in the switch:
```typescript
case "subagent":
	return withSessionId(handleSubagentCommand(db), sessionId);
```

Add handler function:
```typescript
function handleSubagentCommand(db: Database): CommandResult {
	const subagents = listSubagentSessions(db, 5);
	if (subagents.length === 0) {
		return { ok: true, status: "No subagent sessions" };
	}
	const lines = subagents.map((s, i) => `${i + 1}: ${s.title ?? "(untitled)"}`).join("\n");
	return { ok: true, status: lines };
}
```

In `packages/server/src/server.ts`:

Add import:
```typescript
import { listSubagentSessions } from "./session/repository";
```

Add endpoint before the static files handler:

```typescript
if (url.pathname === "/bobai/subagents") {
	if (!options.db) {
		return new Response("Database not available", { status: 503 });
	}
	const subagents = listSubagentSessions(options.db, 5);
	const body = subagents.map((s, i) => ({
		index: i + 1,
		title: s.title ?? "(untitled)",
		sessionId: s.id,
	}));
	return Response.json(body);
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/dot-command.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add .subagent dot command and GET /bobai/subagents endpoint
```

---

## Task 10: UI Changes — WebSocket Routing + Subagent Panels + Dot Panel

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts`
- Modify: `packages/ui/src/App.tsx`

This task modifies the UI to:
1. Handle `sessionId` on incoming messages (route to parent vs subagent)
2. Handle `subagent_start` and `subagent_done` message types
3. Show minimal subagent panels (title + running indicator, then summary on done)
4. Add `.subagent` to the dot command list

**Step 1: Update `useWebSocket.ts`**

Add `subagent_start` and `subagent_done` to the `ServerMessage` type:

```typescript
type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "subagent_start"; sessionId: string; title: string }
	| { type: "subagent_done"; sessionId: string };
```

Add a `subagents` state:

```typescript
export type SubagentInfo = {
	sessionId: string;
	title: string;
	status: "running" | "done";
	summary?: string;
};
```

In `useWebSocket`, add:
```typescript
const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
```

Handle incoming messages — ignore child `sessionId` events for message rendering (the subagent panel shows only title + status, not streaming text):

```typescript
if (msg.type === "subagent_start") {
	setSubagents((prev) => [
		...prev,
		{ sessionId: msg.sessionId, title: msg.title, status: "running" },
	]);
	return;
}

if (msg.type === "subagent_done") {
	setSubagents((prev) =>
		prev.map((s) => (s.sessionId === msg.sessionId ? { ...s, status: "done" } : s)),
	);
	return;
}

// Skip events tagged with a child sessionId (don't render in parent chat)
if ("sessionId" in msg && msg.sessionId) return;
```

Add `subagents` to the return object.

**Step 2: Update `App.tsx`**

Add `subagents` to the destructured hook values.

Add `.subagent` to the `DOT_COMMANDS` array:
```typescript
const DOT_COMMANDS = ["model", "session", "subagent", "title", "view"] as const;
```

Add a rendering block for the `.subagent` panel in `renderDotPanel`:
```typescript
} else if (parsed.command === "subagent") {
	content = "Loading subagents...";
	// We'll fetch from /bobai/subagents — for now show local state
	if (subagents.length === 0) {
		content = "No subagent sessions";
	} else {
		content = subagents.map((s, i) => (
			<div key={s.sessionId}>
				{i + 1}: {s.title} ({s.status})
			</div>
		));
	}
}
```

Add subagent panel rendering in `renderPanels()`, inserted inline where the tool_call for "task" appears. For now, use a simpler approach: render subagent panels at the end of the messages area as separate panels when they exist:

```typescript
// After existing panels in renderPanels()
for (const sa of subagents) {
	elements.push(
		<div key={`sa-${sa.sessionId}`} className={`panel panel--subagent ${sa.status === "running" ? "panel--running" : ""}`}>
			<strong>Subagent:</strong> {sa.title}
			{sa.status === "running" && <span className="subagent-indicator"> (running...)</span>}
			{sa.status === "done" && <span className="subagent-indicator"> (done)</span>}
		</div>,
	);
}
```

**Step 3: Verify manually**

Since the UI is React and doesn't have automated tests in this project, verify by:

Run: `bun test` (full server suite — ensure nothing broken)
Expected: PASS

**Step 4: Commit**

```
feat: add subagent UI panels and WebSocket routing for child sessions
```

---

## Task 11: Send `subagent_start` / `subagent_done` from Handler

This task wires the WebSocket events for subagent lifecycle from the task tool through the handler.

**Files:**
- Modify: `packages/server/src/tool/task.ts` (emit `subagent_start` / `subagent_done`)
- Modify: `packages/server/src/handler.ts` (pass WS send capability to task tool deps)

**Step 1: Update TaskToolDeps**

Add a `sendWs` function to `TaskToolDeps`:

```typescript
export interface TaskToolDeps {
	db: Database;
	provider: Provider;
	model: string;
	parentSessionId: string;
	projectRoot: string;
	systemPrompt: string;
	signal?: AbortSignal;
	onEvent: (event: AgentEvent & { sessionId?: string }) => void;
	sendWs: (msg: import("../protocol").ServerMessage) => void;
	subagentStatus: SubagentStatus;
}
```

**Step 2: Emit events in task.ts execute()**

After creating the child session:
```typescript
deps.sendWs({ type: "subagent_start", sessionId: childSessionId, title });
```

After agent loop completes:
```typescript
deps.sendWs({ type: "subagent_done", sessionId: childSessionId });
```

**Step 3: Wire in handler.ts**

Pass `sendWs` when creating the task tool:

```typescript
sendWs: (msg) => send(ws, msg),
```

**Step 4: Write test**

Add to `packages/server/test/task-tool.test.ts`:

```typescript
test("emits subagent_start and subagent_done via sendWs", async () => {
	const wsMsgs: any[] = [];
	const tool = createTaskTool({
		db,
		provider: titleAndAgentProvider("title", "result"),
		model: "test-model",
		parentSessionId: "parent-1",
		projectRoot: "/tmp",
		systemPrompt: "sys",
		onEvent: () => {},
		sendWs: (msg) => wsMsgs.push(msg),
		subagentStatus: new SubagentStatus(),
	});

	await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });

	const startMsg = wsMsgs.find((m) => m.type === "subagent_start");
	expect(startMsg).toBeTruthy();
	expect(startMsg.title).toBeTruthy();
	expect(startMsg.sessionId).toBeTruthy();

	const doneMsg = wsMsgs.find((m) => m.type === "subagent_done");
	expect(doneMsg).toBeTruthy();
	expect(doneMsg.sessionId).toBe(startMsg.sessionId);
});
```

**Step 5: Run tests**

Run: `bun test packages/server/test/task-tool.test.ts`
Expected: PASS

Run: `bun test` (full suite)
Expected: PASS

**Step 6: Commit**

```
feat: emit subagent_start/subagent_done WebSocket events from task tool
```

---

## Task 12: Full Integration Test

**Files:**
- Create: `packages/server/test/subagent-integration.test.ts`

**Step 1: Write integration test**

```typescript
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { getMessages, listSubagentSessions } from "../src/session/repository";
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

describe("subagent integration", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("full subagent flow: parent spawns child, child runs, parent receives result", async () => {
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					// Parent: call the task tool
					yield { type: "tool_call_start", index: 0, id: "call_task_1", name: "task" };
					yield {
						type: "tool_call_delta",
						index: 0,
						arguments: JSON.stringify({
							description: "Explore project structure",
							prompt: "List all files in the project root and summarize what you find.",
						}),
					};
					yield { type: "finish", reason: "tool_calls" };
				} else if (callCount === 2) {
					// Title generation
					yield { type: "text", text: "Project structure overview" };
					yield { type: "finish", reason: "stop" };
				} else if (callCount === 3) {
					// Child agent loop
					yield { type: "text", text: "I found 5 files in the project root." };
					yield { type: "finish", reason: "stop" };
				} else {
					// Parent continues after tool result
					yield { type: "text", text: "The subagent found 5 files." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "Explore the project",
			projectRoot: "/tmp",
		});

		const msgs = ws.messages();

		// Should have completed successfully
		const done = msgs.find((m: any) => m.type === "done");
		expect(done).toBeTruthy();

		// Should have a subagent session in the DB
		const subagents = listSubagentSessions(db);
		expect(subagents.length).toBeGreaterThanOrEqual(1);

		// The latest subagent should have the generated title
		const latestSubagent = subagents[0];
		expect(latestSubagent.title).toBeTruthy();

		// Child session should have messages
		const childMessages = getMessages(db, latestSubagent.id);
		expect(childMessages.length).toBeGreaterThanOrEqual(3); // system + user + assistant

		// Parent's final response should reference the subagent result
		const tokens = msgs.filter((m: any) => m.type === "token" && !m.sessionId);
		const parentText = tokens.map((t: any) => t.text).join("");
		expect(parentText).toContain("5 files");
	});
});
```

**Step 2: Run test**

Run: `bun test packages/server/test/subagent-integration.test.ts`
Expected: PASS

**Step 3: Run full suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit**

```
test: add subagent integration test covering full parent-child flow
```

---

## Summary

| Task | Component | Files | Test File |
|------|-----------|-------|-----------|
| 1 | Schema migration | project.ts, helpers.ts | subagent-schema.test.ts |
| 2 | Repository functions | repository.ts | repository.test.ts |
| 3 | Protocol changes | protocol.ts | protocol.test.ts |
| 4 | Agent loop changes | agent-loop.ts | agent-loop.test.ts |
| 5 | Status tracker | subagent-status.ts | subagent-status.test.ts |
| 6 | Task tool | tool/task.ts | task-tool.test.ts |
| 7 | Handler wiring | handler.ts | handler.test.ts |
| 8 | System prompt | system-prompt.ts | system-prompt.test.ts |
| 9 | Dot command + endpoint | command.ts, server.ts | dot-command.test.ts |
| 10 | UI changes | useWebSocket.ts, App.tsx | (manual) |
| 11 | WS lifecycle events | tool/task.ts, handler.ts | task-tool.test.ts |
| 12 | Integration test | — | subagent-integration.test.ts |

**Total: 12 tasks, each independently testable. Tasks 1-9 are backend-only. Task 10 is UI. Tasks 11-12 are integration/polish.**
