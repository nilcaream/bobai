# LLM Provider Integration — Design

**Goal:** Replace the stub handler with real LLM provider calls, starting with GitHub Copilot.

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SDK approach | Hand-rolled | Full control over every byte between Bob and the provider. Aligns with radical context transparency. |
| First provider | GitHub Copilot | OpenAI-compatible Chat Completions API. Free with `gpt-5-mini`. |
| Auth mechanism | GitHub PAT in `~/.config/bobai/auth.json` | Simple, persistent, no OAuth complexity for MVP. |
| Default model | `gpt-5-mini` | Free tier, sufficient for development and testing. |
| Config precedence | Project > Global > Defaults | Standard layered config. Auth is always global (user-scoped). |
| Conversation history | Stateless for now | Each prompt sends system + single user message. Multi-turn requires SQLite schema (next step). |

---

## Provider Interface

A single interface that any LLM provider must implement:

```typescript
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ProviderOptions {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
}

interface Provider {
  readonly id: string;
  stream(options: ProviderOptions): AsyncIterable<string>;
}
```

The `stream()` method takes messages and yields text chunks. The consumer iterates the async iterable and forwards each chunk over WebSocket.

---

## GitHub Copilot Provider

Hits `https://api.githubcopilot.com/chat/completions` with:

- `Authorization: Bearer <github-pat>`
- `Content-Type: application/json`
- `Openai-Intent: conversation-edits`
- Body: `{ model, messages, stream: true }`

Parses the SSE response stream manually: splits on `\n\n`, strips `data: ` prefix, parses JSON, extracts `choices[0].delta.content`. Terminates on `data: [DONE]`.

Errors throw a `ProviderError` with status code and response body. No retries for MVP.

---

## Config System

### File Layout

```
~/.config/bobai/
  auth.json        Credentials keyed by provider ID
  bobai.json       Global preferences (default provider, model)

.bobai/
  bobai.json       Per-project overrides (existing file, extended)
```

### auth.json

```json
{ "github-copilot": { "token": "ghp_..." } }
```

Keyed by provider ID so it extends naturally for future providers.

### Global bobai.json (`~/.config/bobai/bobai.json`)

```json
{ "provider": "github-copilot", "model": "gpt-5-mini" }
```

### Project bobai.json (`.bobai/bobai.json`)

```json
{ "id": "...", "port": 3000, "provider": "github-copilot", "model": "claude-sonnet-4" }
```

Existing `id` and `port` fields remain. `provider` and `model` are optional overrides.

### Resolution

Precedence: project config > global config > defaults.

Defaults: `{ provider: "github-copilot", model: "gpt-5-mini" }`.

If no auth token exists, the server prints setup instructions and exits.

---

## Handler Changes

`handlePrompt` receives the provider via dependency injection:

```typescript
async function handlePrompt(ws, msg, provider, model) {
  const messages = [
    { role: "system", content: "You are Bob AI, a coding assistant." },
    { role: "user", content: msg.text },
  ];

  for await (const text of provider.stream({ model, messages })) {
    send(ws, { type: "token", text });
  }
  send(ws, { type: "done" });
}
```

Errors are caught and forwarded as WebSocket `error` messages.

---

## Startup Flow Changes

1. Load global config + auth from `~/.config/bobai/`
2. Init project (existing flow)
3. Merge configs: project > global > defaults
4. Validate auth token exists (exit with instructions if missing)
5. Create provider: `createCopilotProvider(token)`
6. Pass provider + model to `createServer()`

---

## File Layout

```
packages/server/src/
  provider/
    provider.ts      Provider interface, Message type, ProviderError
    copilot.ts       GitHub Copilot implementation (fetch + SSE)
    sse.ts           SSE stream parser (shared utility)
    resolve.ts       Provider instantiation from resolved config
  config/
    global.ts        Read ~/.config/bobai/ (auth.json, bobai.json)
    project.ts       Existing .bobai/bobai.json (extended)
    resolve.ts       Merge: project > global > defaults
```

---

## Protocol

No protocol changes. Existing `token`/`done`/`error` messages handle streaming LLM responses. Protocol expansion (tool calls, context telemetry) is deferred.

---

## Not in Scope

- Conversation history / multi-turn (requires SQLite schema)
- Tool calling
- Retries / exponential backoff
- Context telemetry
- OpenCode Zen provider (second provider validates the abstraction)

---

## Implementation Plan

**Goal:** Replace the stub handler with a hand-rolled GitHub Copilot provider integration.

**Architecture:** A `Provider` interface with a single `stream()` method returning `AsyncIterable<string>`. A GitHub Copilot implementation using `fetch` + manual SSE parsing. A three-layer config system (project > global > defaults) with auth stored at `~/.config/bobai/auth.json`.

**Tech Stack:** Bun, TypeScript, no external dependencies.

---

### Task 1: Provider Interface and ProviderError

**Files:**
- Create: `packages/server/src/provider/provider.ts`
- Test: `packages/server/test/provider.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/server/test/provider.test.ts
import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/provider/provider";

describe("ProviderError", () => {
	test("stores status and body", () => {
		const err = new ProviderError(401, "Unauthorized");
		expect(err.status).toBe(401);
		expect(err.body).toBe("Unauthorized");
		expect(err.message).toBe("Provider error (401): Unauthorized");
		expect(err).toBeInstanceOf(Error);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/provider.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/server/src/provider/provider.ts
export interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ProviderOptions {
	model: string;
	messages: Message[];
	signal?: AbortSignal;
}

export interface Provider {
	readonly id: string;
	stream(options: ProviderOptions): AsyncIterable<string>;
}

export class ProviderError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
	) {
		super(`Provider error (${status}): ${body}`);
		this.name = "ProviderError";
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/provider.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(server): add Provider interface and ProviderError
```

---

### Task 2: SSE Stream Parser

**Files:**
- Create: `packages/server/src/provider/sse.ts`
- Test: `packages/server/test/sse.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/server/test/sse.test.ts
import { describe, expect, test } from "bun:test";
import { parseSSE } from "../src/provider/sse";

function toStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("parseSSE", () => {
	test("parses single data line", async () => {
		const stream = toStream('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([{ choices: [{ delta: { content: "hello" } }] }]);
	});

	test("parses multiple events", async () => {
		const stream = toStream(
			'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
		);
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(2);
	});

	test("stops on [DONE] sentinel", async () => {
		const stream = toStream(
			'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
		);
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});

	test("skips empty lines and non-data lines", async () => {
		const stream = toStream(
			': comment\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
		);
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});

	test("handles chunked data split across stream reads", async () => {
		const full = 'data: {"choices":[{"delta":{"content":"split"}}]}\n\n';
		const mid = Math.floor(full.length / 2);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(full.slice(0, mid)));
				controller.enqueue(new TextEncoder().encode(full.slice(mid)));
				controller.close();
			},
		});
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/sse.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/server/src/provider/sse.ts
export async function* parseSSE(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			const line = part.trim();
			if (!line.startsWith("data: ")) continue;

			const data = line.slice("data: ".length);
			if (data === "[DONE]") return;

			yield JSON.parse(data);
		}
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/sse.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(server): add SSE stream parser
```

---

### Task 3: GitHub Copilot Provider

**Files:**
- Create: `packages/server/src/provider/copilot.ts`
- Test: `packages/server/test/copilot.test.ts`

**Step 1: Write the failing tests**

These tests mock `fetch` to verify the provider sends the correct request and yields tokens from the SSE response.

```typescript
// packages/server/test/copilot.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createCopilotProvider } from "../src/provider/copilot";
import { ProviderError } from "../src/provider/provider";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
	const text = events.map((e) => `data: ${e}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function chatChunk(content: string): string {
	return JSON.stringify({ choices: [{ delta: { content } }] });
}

describe("CopilotProvider", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("has correct id", () => {
		const provider = createCopilotProvider("tok");
		expect(provider.id).toBe("github-copilot");
	});

	test("sends correct request to Copilot API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider("test-token");
		const tokens: string[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hello" }],
		})) {
			tokens.push(t);
		}

		expect(capturedUrl).toBe("https://api.githubcopilot.com/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer test-token");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("gpt-5-mini");
		expect(body.stream).toBe(true);
	});

	test("yields content tokens from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([chatChunk("Hello"), chatChunk(" world"), "[DONE]"]),
				{ status: 200 },
			);
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		const tokens: string[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			tokens.push(t);
		}

		expect(tokens).toEqual(["Hello", " world"]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		const provider = createCopilotProvider("bad-token");
		const iter = provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		});

		expect(async () => {
			for await (const _ of iter) {
				/* drain */
			}
		}).toThrow(ProviderError);
	});

	test("skips chunks with no delta content", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(
				sseStream([
					JSON.stringify({ choices: [{ delta: {} }] }),
					chatChunk("only"),
					"[DONE]",
				]),
				{ status: 200 },
			);
		}) as typeof fetch;

		const provider = createCopilotProvider("tok");
		const tokens: string[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			tokens.push(t);
		}

		expect(tokens).toEqual(["only"]);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/copilot.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/server/src/provider/copilot.ts
import type { Provider, ProviderOptions } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_API = "https://api.githubcopilot.com/chat/completions";

export function createCopilotProvider(token: string): Provider {
	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<string> {
			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Openai-Intent": "conversation-edits",
				},
				body: JSON.stringify({
					model: options.model,
					messages: options.messages,
					stream: true,
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}

			for await (const event of parseSSE(response.body!)) {
				const data = event as {
					choices?: { delta?: { content?: string } }[];
				};
				const content = data.choices?.[0]?.delta?.content;
				if (content) yield content;
			}
		},
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/copilot.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(server): add GitHub Copilot provider
```

---

### Task 4: Global Config Reader

**Files:**
- Create: `packages/server/src/config/global.ts`
- Test: `packages/server/test/global-config.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/server/test/global-config.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadGlobalConfig } from "../src/config/global";

describe("loadGlobalConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-global-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns empty config when directory does not exist", () => {
		const config = loadGlobalConfig(path.join(tmpDir, "nonexistent"));
		expect(config).toEqual({ auth: {}, preferences: {} });
	});

	test("reads auth.json keyed by provider id", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "auth.json"),
			JSON.stringify({ "github-copilot": { token: "ghp_test" } }),
		);
		const config = loadGlobalConfig(tmpDir);
		expect(config.auth["github-copilot"]?.token).toBe("ghp_test");
	});

	test("reads bobai.json preferences", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "bobai.json"),
			JSON.stringify({ provider: "github-copilot", model: "gpt-5-mini" }),
		);
		const config = loadGlobalConfig(tmpDir);
		expect(config.preferences.provider).toBe("github-copilot");
		expect(config.preferences.model).toBe("gpt-5-mini");
	});

	test("returns empty objects when files are missing", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		const config = loadGlobalConfig(tmpDir);
		expect(config.auth).toEqual({});
		expect(config.preferences).toEqual({});
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/global-config.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/server/src/config/global.ts
import fs from "node:fs";
import path from "node:path";

export interface AuthEntry {
	token: string;
}

export interface GlobalPreferences {
	provider?: string;
	model?: string;
}

export interface GlobalConfig {
	auth: Record<string, AuthEntry>;
	preferences: GlobalPreferences;
}

export function loadGlobalConfig(configDir: string): GlobalConfig {
	const auth = readJson<Record<string, AuthEntry>>(path.join(configDir, "auth.json")) ?? {};
	const preferences = readJson<GlobalPreferences>(path.join(configDir, "bobai.json")) ?? {};
	return { auth, preferences };
}

function readJson<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/global-config.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(server): add global config reader for auth and preferences
```

---

### Task 5: Config Resolution (merge layers)

**Files:**
- Create: `packages/server/src/config/resolve.ts`
- Test: `packages/server/test/config-resolve.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/server/test/config-resolve.test.ts
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/resolve";

describe("resolveConfig", () => {
	test("returns defaults when no overrides provided", () => {
		const config = resolveConfig({}, {});
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-5-mini");
	});

	test("global preferences override defaults", () => {
		const config = resolveConfig({}, { provider: "zen", model: "zen-1" });
		expect(config.provider).toBe("zen");
		expect(config.model).toBe("zen-1");
	});

	test("project config overrides global preferences", () => {
		const config = resolveConfig(
			{ provider: "github-copilot", model: "claude-sonnet-4" },
			{ provider: "zen", model: "zen-1" },
		);
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("claude-sonnet-4");
	});

	test("partial project config merges with global", () => {
		const config = resolveConfig(
			{ model: "gpt-4o" },
			{ provider: "github-copilot", model: "gpt-5-mini" },
		);
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-4o");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/config-resolve.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/server/src/config/resolve.ts
export interface ResolvedConfig {
	provider: string;
	model: string;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
}

const DEFAULTS: ResolvedConfig = {
	provider: "github-copilot",
	model: "gpt-5-mini",
};

export function resolveConfig(
	project: ConfigLayer,
	global: ConfigLayer,
): ResolvedConfig {
	return {
		provider: project.provider ?? global.provider ?? DEFAULTS.provider,
		model: project.model ?? global.model ?? DEFAULTS.model,
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/config-resolve.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(server): add config resolution with project > global > defaults
```

---

### Task 6: Extend Project Config and Update Handler

**Files:**
- Modify: `packages/server/src/project.ts` — add `provider` and `model` to `BobaiConfig`
- Modify: `packages/server/src/handler.ts` — replace stub with provider calls
- Modify: `packages/server/src/server.ts` — accept provider + model in options, pass to handler
- Test: `packages/server/test/handler.test.ts` (new — unit test with mock provider)

**Step 1: Write the failing handler test**

```typescript
// packages/server/test/handler.test.ts
import { describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

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

function failingProvider(status: number, body: string): Provider {
	return {
		id: "mock",
		async *stream() {
			throw new ProviderError(status, body);
		},
	};
}

describe("handlePrompt", () => {
	test("streams provider tokens then done", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		await handlePrompt(ws, { type: "prompt", text: "hi" }, provider, "test-model");
		const msgs = ws.messages();
		expect(msgs.at(-1)).toEqual({ type: "done" });
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " world" },
		]);
	});

	test("sends error message on ProviderError", async () => {
		const ws = mockWs();
		const provider = failingProvider(401, "Unauthorized");
		await handlePrompt(ws, { type: "prompt", text: "hi" }, provider, "test-model");
		const msgs = ws.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("401");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/handler.test.ts`
Expected: FAIL — handlePrompt signature mismatch (still the 2-arg stub)

**Step 3: Update the source files**

Update `packages/server/src/project.ts` — add optional `provider` and `model` to `BobaiConfig`:

```typescript
export interface BobaiConfig {
	id?: string;
	port?: number;
	provider?: string;
	model?: string;
}

export interface Project {
	id: string;
	port?: number;
	provider?: string;
	model?: string;
	dir: string;
	db: Database;
}
```

And update the return in `initProject` to include `provider` and `model`:

```typescript
return { id, port: config.port, provider: config.provider, model: config.model, dir: bobaiDir, db };
```

Replace `packages/server/src/handler.ts`:

```typescript
import type { Provider, Message } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";

export async function handlePrompt(
	ws: { send: (msg: string) => void },
	msg: ClientMessage,
	provider: Provider,
	model: string,
) {
	try {
		const messages: Message[] = [
			{ role: "system", content: "You are Bob AI, a coding assistant." },
			{ role: "user", content: msg.text },
		];

		for await (const text of provider.stream({ model, messages })) {
			send(ws, { type: "token", text });
		}
		send(ws, { type: "done" });
	} catch (err) {
		const message =
			err instanceof ProviderError
				? `Provider error (${err.status}): ${err.body}`
				: "Unexpected error during generation";
		send(ws, { type: "error", message });
	}
}
```

Update `packages/server/src/server.ts` — accept provider + model, pass to handler:

```typescript
import type { Provider } from "./provider/provider";

export interface ServerOptions {
	port: number;
	staticDir?: string;
	provider?: Provider;
	model?: string;
}
```

And in the websocket message handler:

```typescript
if (msg.type === "prompt") {
	if (options.provider && options.model) {
		handlePrompt(ws, msg, options.provider, options.model);
	} else {
		send(ws, { type: "error", message: "No provider configured" });
	}
	return;
}
```

**Step 4: Run handler tests and then ALL tests**

Run: `bun test test/handler.test.ts`
Expected: PASS

Run: `bun test`
Expected: ALL PASS (session.test.ts will need adjustment — see next step)

Note: The existing `session.test.ts` creates a server without a provider. Its "streams token messages" test will now get an error message instead of tokens. Update `session.test.ts` to create the server with a mock provider, or accept that the test now verifies the "no provider configured" error path.

**Step 5: Update session.test.ts to use a mock provider**

Replace the token-streaming test to use a mock provider passed to `createServer`:

```typescript
beforeAll(() => {
	const provider: Provider = {
		id: "test",
		async *stream() { yield "test "; yield "response"; },
	};
	server = createServer({ port: 0, provider, model: "test-model" });
	wsUrl = `ws://localhost:${server.port}/bobai/ws`;
});
```

**Step 6: Run all tests**

Run: `bun test`
Expected: ALL PASS

**Step 7: Commit**

```
feat(server): wire provider into handler and server
```

---

### Task 7: Wire Up Startup (index.ts)

**Files:**
- Modify: `packages/server/src/index.ts`

**Step 1: Update index.ts**

```typescript
import path from "node:path";
import os from "node:os";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { resolvePort } from "./port";
import { createCopilotProvider } from "./provider/copilot";
import { initProject } from "./project";
import { createServer } from "./server";

const projectRoot = process.cwd();
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");
const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(projectRoot);
const config = resolveConfig(
	{ provider: project.provider, model: project.model },
	globalConfig.preferences,
);

const token = globalConfig.auth[config.provider]?.token;
if (!token) {
	console.error(`No auth token found for provider "${config.provider}".`);
	console.error(`\nSet up authentication:`);
	console.error(`  mkdir -p ~/.config/bobai`);
	console.error(`  echo '{"${config.provider}": {"token": "YOUR_TOKEN"}}' > ~/.config/bobai/auth.json`);
	process.exit(1);
}

const provider = createCopilotProvider(token);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const server = createServer({ port, staticDir, provider, model: config.model });

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
```

**Step 2: Run all tests to make sure nothing broke**

Run: `bun test`
Expected: ALL PASS

**Step 3: Manual smoke test**

Set up auth:
```bash
mkdir -p ~/.config/bobai
echo '{"github-copilot": {"token": "YOUR_GITHUB_TOKEN"}}' > ~/.config/bobai/auth.json
```

Run: `bun run dev` (from `packages/server/`)
Expected: Server starts, prints provider info, opens browser, typing a prompt gets a real LLM response.

**Step 4: Commit**

```
feat(server): wire LLM provider into startup flow
```

---

### Task 8: Verify and Run All Tests

**Step 1: Run full test suite**

Run: `bun test` (from `packages/server/`)
Expected: ALL PASS

**Step 2: Run biome check**

Run: `bun run check` (from `packages/server/`)
Expected: No errors

**Step 3: Fix any lint issues found by biome**
