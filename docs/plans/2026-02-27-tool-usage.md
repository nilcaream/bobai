# Tool Usage Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Give the LLM the ability to call tools (starting with `read_file` and `list_directory`) via the OpenAI function-calling protocol, so Bob AI can actually read files and browse directories in the user's project.

**Architecture:** A new agent loop (`agent-loop.ts`) drives the provider↔tool cycle: call the LLM → if it requests tool calls, execute them sequentially → append results → call again → repeat until the LLM stops. The Copilot provider is updated to send tool definitions in the request body and parse `delta.tool_calls` from SSE responses. A tool registry holds tool definitions and executors. Messages gain a `metadata` column for tool call/result data. The WebSocket protocol gains `tool_call` and `tool_result` event types for the frontend.

**Tech Stack:** Bun runtime, TypeScript, `bun:sqlite`, existing WebSocket server, React 19 frontend.

**Conventions:** Biome (tabs, 128-char lines), `bun:test`, Conventional Commits. Run tests with `bun test packages/server/test/`.

---

### Task 1: Expand Provider Types — StreamEvent, ToolDefinition, Message

**Files:**
- Modify: `packages/server/src/provider/provider.ts`
- Test: `packages/server/test/provider.test.ts`

This task replaces the simple `AsyncIterable<string>` streaming with a typed `StreamEvent` discriminated union, adds `ToolDefinition` for the OpenAI function-calling format, and expands `Message` to support `tool_calls` on assistant messages and `role: "tool"` for tool results.

**Step 1: Write the failing tests**

Add to `packages/server/test/provider.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/provider/provider";
import type {
	AssistantMessage,
	Message,
	StreamEvent,
	SystemMessage,
	ToolDefinition,
	ToolMessage,
	ToolCallContent,
	UserMessage,
} from "../src/provider/provider";

describe("ProviderError", () => {
	test("stores status and body", () => {
		const err = new ProviderError(401, "Unauthorized");
		expect(err.status).toBe(401);
		expect(err.body).toBe("Unauthorized");
		expect(err.message).toBe("Provider error (401): Unauthorized");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("type contracts", () => {
	test("StreamEvent discriminated union covers all variants", () => {
		const events: StreamEvent[] = [
			{ type: "text", text: "hello" },
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"pat' },
			{ type: "finish", reason: "stop" },
			{ type: "finish", reason: "tool_calls" },
		];
		expect(events).toHaveLength(5);
		expect(events[0].type).toBe("text");
		expect(events[3].type).toBe("finish");
	});

	test("ToolDefinition matches OpenAI function-calling format", () => {
		const def: ToolDefinition = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "File path" } },
					required: ["path"],
				},
			},
		};
		expect(def.type).toBe("function");
		expect(def.function.name).toBe("read_file");
	});

	test("Message union supports all four roles", () => {
		const system: SystemMessage = { role: "system", content: "You are helpful" };
		const user: UserMessage = { role: "user", content: "hi" };
		const assistant: AssistantMessage = { role: "assistant", content: "hello" };
		const assistantWithTools: AssistantMessage = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
		};
		const toolResult: ToolMessage = { role: "tool", content: "file contents", tool_call_id: "call_1" };

		const msgs: Message[] = [system, user, assistant, assistantWithTools, toolResult];
		expect(msgs).toHaveLength(5);
		expect(assistantWithTools.tool_calls).toHaveLength(1);
		expect(toolResult.tool_call_id).toBe("call_1");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/provider.test.ts`
Expected: FAIL — types don't exist yet.

**Step 3: Write the implementation**

Replace the entire contents of `packages/server/src/provider/provider.ts`:

```typescript
// --- Message types (OpenAI-compatible) ---

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface UserMessage {
	role: "user";
	content: string;
}

export interface ToolCallContent {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCallContent[];
}

export interface ToolMessage {
	role: "tool";
	content: string;
	tool_call_id: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// --- Tool definition (OpenAI function-calling format) ---

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

// --- Stream events ---

export type StreamEvent =
	| { type: "text"; text: string }
	| { type: "tool_call_start"; index: number; id: string; name: string }
	| { type: "tool_call_delta"; index: number; arguments: string }
	| { type: "finish"; reason: "stop" | "tool_calls" };

// --- Provider interface ---

export interface ProviderOptions {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	signal?: AbortSignal;
}

export interface Provider {
	readonly id: string;
	stream(options: ProviderOptions): AsyncIterable<StreamEvent>;
}

// --- Errors ---

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

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/provider.test.ts`
Expected: PASS.

**Step 5: Fix downstream compilation**

The `Message` type changed shape. Update all files that import from `provider.ts` so they compile. **Do NOT change behavior yet** — just fix type references so `bun test packages/server/test/` passes. Specifically:

- `copilot.ts`: The `stream()` return type changes from `AsyncGenerator<string>` to `AsyncGenerator<StreamEvent>`. For now, wrap each text chunk: `yield { type: "text", text: content } as StreamEvent`. At the end of the SSE loop (after `[DONE]`), yield `{ type: "finish", reason: "stop" }`. The `resolveInitiator` function receives `Message[]` — update it to check `last?.role === "user"` (still works since `Message` union still has a `role` field).
- `handler.ts`: The `for await (const chunk of provider.stream(...))` loop currently expects `string`. Change it to handle `StreamEvent`: if `chunk.type === "text"`, use `chunk.text`. Ignore other event types for now.
- `handler.test.ts`: The `mockProvider`, `capturingProvider`, `failingProvider`, and `partialFailingProvider` helpers all yield `string`. Update them to yield `StreamEvent` objects instead. `mockProvider(["Hello"])` becomes yielding `{ type: "text", text: "Hello" }` then `{ type: "finish", reason: "stop" }`.
- `session.test.ts`: The inline provider yields `string`. Update it to yield `StreamEvent` objects.

Run: `bun test packages/server/test/`
Expected: All 106 tests pass.

**Step 6: Commit**

```
feat(server): expand provider types with StreamEvent, ToolDefinition, and tool-aware Message union
```

---

### Task 2: Tool Framework — Tool Interface and Registry

**Files:**
- Create: `packages/server/src/tool/tool.ts`
- Test: `packages/server/test/tool.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/tool.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "../src/tool/tool";
import type { Tool, ToolContext, ToolResult } from "../src/tool/tool";

function fakeTool(name: string): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name,
				description: `Fake ${name}`,
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
		execute: async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
			return { output: `executed ${name}` };
		},
	};
}

describe("createToolRegistry", () => {
	test("returns definitions for all registered tools", () => {
		const registry = createToolRegistry([fakeTool("alpha"), fakeTool("beta")]);
		expect(registry.definitions).toHaveLength(2);
		expect(registry.definitions[0].function.name).toBe("alpha");
		expect(registry.definitions[1].function.name).toBe("beta");
	});

	test("get returns tool by name", () => {
		const tool = fakeTool("alpha");
		const registry = createToolRegistry([tool]);
		expect(registry.get("alpha")).toBe(tool);
	});

	test("get returns undefined for unknown tool", () => {
		const registry = createToolRegistry([fakeTool("alpha")]);
		expect(registry.get("unknown")).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/tool.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/tool/tool.ts`:

```typescript
import type { ToolDefinition } from "../provider/provider";

export interface ToolContext {
	projectRoot: string;
}

export interface ToolResult {
	output: string;
	isError?: boolean;
}

export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
	definitions: ToolDefinition[];
	get(name: string): Tool | undefined;
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
	const map = new Map<string, Tool>();
	for (const tool of tools) {
		map.set(tool.definition.function.name, tool);
	}
	return {
		definitions: tools.map((t) => t.definition),
		get(name: string) {
			return map.get(name);
		},
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/tool.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add tool framework with Tool interface and registry
```

---

### Task 3: read_file Tool

**Files:**
- Create: `packages/server/src/tool/read-file.ts`
- Test: `packages/server/test/read-file.test.ts`

The tool reads a file relative to the project root. It must prevent path traversal (escaping the project root via `..`). If the file doesn't exist or is outside the project root, it returns an error result.

**Step 1: Write the failing tests**

Create `packages/server/test/read-file.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileTool } from "../src/tool/read-file";
import type { ToolContext } from "../src/tool/tool";

describe("readFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-read-file-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "hello.txt"), "Hello, world!");
		fs.mkdirSync(path.join(tmpDir, "sub"));
		fs.writeFileSync(path.join(tmpDir, "sub", "nested.txt"), "nested content");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(readFileTool.definition.function.name).toBe("read_file");
		expect(readFileTool.definition.function.parameters).toHaveProperty("properties");
	});

	test("reads a file at project root", async () => {
		const result = await readFileTool.execute({ path: "hello.txt" }, ctx);
		expect(result.output).toBe("Hello, world!");
		expect(result.isError).toBeUndefined();
	});

	test("reads a nested file", async () => {
		const result = await readFileTool.execute({ path: "sub/nested.txt" }, ctx);
		expect(result.output).toBe("nested content");
	});

	test("returns error for nonexistent file", async () => {
		const result = await readFileTool.execute({ path: "nope.txt" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("nope.txt");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await readFileTool.execute({ path: "../../etc/passwd" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when path is missing", async () => {
		const result = await readFileTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/read-file.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/tool/read-file.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const readFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "read_file",
			description: "Read the contents of a file. The path is relative to the project root.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
				},
				required: ["path"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		try {
			const content = fs.readFileSync(resolved, "utf-8");
			return { output: content };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: file not found: ${filePath}`, isError: true };
			}
			if (code === "EISDIR") {
				return { output: `Error: '${filePath}' is a directory, not a file. Use list_directory instead.`, isError: true };
			}
			return { output: `Error reading file: ${(err as Error).message}`, isError: true };
		}
	},
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/read-file.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add read_file tool with path traversal protection
```

---

### Task 4: list_directory Tool

**Files:**
- Create: `packages/server/src/tool/list-directory.ts`
- Test: `packages/server/test/list-directory.test.ts`

The tool lists entries in a directory relative to the project root. Directories get a trailing `/` suffix. Same path traversal protection as `read_file`.

**Step 1: Write the failing tests**

Create `packages/server/test/list-directory.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listDirectoryTool } from "../src/tool/list-directory";
import type { ToolContext } from "../src/tool/tool";

describe("listDirectoryTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-list-dir-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "file-a.txt"), "a");
		fs.writeFileSync(path.join(tmpDir, "file-b.txt"), "b");
		fs.mkdirSync(path.join(tmpDir, "subdir"));
		fs.writeFileSync(path.join(tmpDir, "subdir", "child.txt"), "c");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(listDirectoryTool.definition.function.name).toBe("list_directory");
	});

	test("lists project root when path is '.'", async () => {
		const result = await listDirectoryTool.execute({ path: "." }, ctx);
		expect(result.isError).toBeUndefined();
		const lines = result.output.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.txt");
		expect(lines).toContain("file-b.txt");
		expect(lines).toContain("subdir/");
	});

	test("lists subdirectory contents", async () => {
		const result = await listDirectoryTool.execute({ path: "subdir" }, ctx);
		const lines = result.output.split("\n").filter(Boolean);
		expect(lines).toContain("child.txt");
	});

	test("returns error for nonexistent directory", async () => {
		const result = await listDirectoryTool.execute({ path: "nope" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("nope");
	});

	test("returns error for path traversal", async () => {
		const result = await listDirectoryTool.execute({ path: "../../" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when path is a file, not a directory", async () => {
		const result = await listDirectoryTool.execute({ path: "file-a.txt" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not a directory");
	});

	test("defaults to project root when path is omitted", async () => {
		const result = await listDirectoryTool.execute({}, ctx);
		expect(result.isError).toBeUndefined();
		const lines = result.output.split("\n").filter(Boolean);
		expect(lines).toContain("file-a.txt");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/list-directory.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/tool/list-directory.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const listDirectoryTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "list_directory",
			description: "List the contents of a directory. The path is relative to the project root. Defaults to the project root if path is omitted.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the directory from the project root. Defaults to '.' (project root).",
					},
				},
				required: [],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";

		const resolved = path.resolve(ctx.projectRoot, dirPath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${dirPath}' resolves outside the project root`, isError: true };
		}

		try {
			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			return { output: lines.join("\n") };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: directory not found: ${dirPath}`, isError: true };
			}
			if (code === "ENOTDIR") {
				return { output: `Error: '${dirPath}' is not a directory`, isError: true };
			}
			return { output: `Error listing directory: ${(err as Error).message}`, isError: true };
		}
	},
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/list-directory.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add list_directory tool with path traversal protection
```

---

### Task 5: Copilot Provider — Send Tools and Parse tool_calls

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Test: `packages/server/test/copilot.test.ts`

This task updates the Copilot provider to: (a) include `tools` in the request body when provided, and (b) parse `delta.tool_calls` from the SSE stream, yielding `tool_call_start` and `tool_call_delta` events. The finish reason is read from `choices[0].finish_reason`.

Note: The `copilot.test.ts` file already has tests for the provider using mocked HTTP responses. We need to add tests for tool_calls parsing. The existing tests will need updating because `stream()` now yields `StreamEvent` instead of `string`.

**Step 1: Write the failing tests**

Add new tests to `packages/server/test/copilot.test.ts`. If the existing tests yield `string` assertions, update them to assert on `StreamEvent` objects. Add these new tests:

```typescript
// Add test: "includes tools in request body when provided"
// Mock fetch to capture the request body, verify it contains tools array

// Add test: "parses delta.tool_calls into tool_call_start and tool_call_delta events"
// Mock SSE stream that returns:
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\""}}]}}]}
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"src/index.ts\"}"}}]}}]}
//   data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}
//   data: [DONE]
// Verify we get: tool_call_start, tool_call_delta, tool_call_delta, finish(tool_calls)

// Add test: "yields finish with reason 'stop' for normal completion"
// Already partially covered — verify the finish event has reason "stop"
```

The implementer should read the existing `copilot.test.ts` file to understand the test patterns already in use and adapt accordingly. The key SSE shape for tool calls is:

```json
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "read_file", "arguments": "" }
      }]
    }
  }]
}
```

Subsequent chunks only have `index` and `function.arguments` (no `id` or `name`):

```json
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "function": { "arguments": "{\"path\":" }
      }]
    }
  }]
}
```

The final chunk has `"finish_reason": "tool_calls"` (instead of `"stop"`).

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: FAIL — new tests fail, existing tests may fail due to type change.

**Step 3: Write the implementation**

Update `packages/server/src/provider/copilot.ts`:

```typescript
import pkg from "../../package.json";
import type { Message, Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_API = "https://api.githubcopilot.com/chat/completions";
const USER_AGENT = `bobai/${pkg.version}`;

function resolveInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last?.role === "user" ? "user" : "agent";
}

interface SSEDelta {
	content?: string;
	tool_calls?: {
		index: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}[];
}

interface SSEChoice {
	delta?: SSEDelta;
	finish_reason?: string | null;
}

interface SSEData {
	choices?: SSEChoice[];
}

export function createCopilotProvider(token: string, configHeaders: Record<string, string> = {}): Provider {
	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			const defaults: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"Openai-Intent": "conversation-edits",
			};

			const body: Record<string, unknown> = {
				model: options.model,
				messages: options.messages,
				stream: true,
			};
			if (options.tools && options.tools.length > 0) {
				body.tools = options.tools;
			}

			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					...defaults,
					...configHeaders,
					Authorization: `Bearer ${token}`,
					"x-initiator": resolveInitiator(options.messages),
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}

			if (!response.body) {
				return;
			}

			let finishReason: "stop" | "tool_calls" = "stop";

			for await (const event of parseSSE(response.body)) {
				const data = event as SSEData;
				const choice = data.choices?.[0];
				if (!choice) continue;

				// Check for finish_reason
				if (choice.finish_reason === "tool_calls") {
					finishReason = "tool_calls";
				} else if (choice.finish_reason === "stop") {
					finishReason = "stop";
				}

				// Handle text content
				const content = choice.delta?.content;
				if (content) {
					yield { type: "text", text: content };
				}

				// Handle tool calls
				const toolCalls = choice.delta?.tool_calls;
				if (toolCalls) {
					for (const tc of toolCalls) {
						if (tc.id && tc.function?.name) {
							// First chunk for this tool call — has id and name
							yield { type: "tool_call_start", index: tc.index, id: tc.id, name: tc.function.name };
						}
						if (tc.function?.arguments) {
							yield { type: "tool_call_delta", index: tc.index, arguments: tc.function.arguments };
						}
					}
				}
			}

			yield { type: "finish", reason: finishReason };
		},
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): update Copilot provider to send tools and parse tool_calls from SSE stream
```

---

### Task 6: Protocol — Add tool_call and tool_result ServerMessage Types

**Files:**
- Modify: `packages/server/src/protocol.ts`
- Test: `packages/server/test/protocol.test.ts`

**Step 1: Write the failing tests**

Add to `packages/server/test/protocol.test.ts` (read the existing file first to see existing test patterns):

```typescript
// Add tests for the new ServerMessage variants:

test("send encodes tool_call message", () => {
	const ws = mockWs();
	send(ws, { type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "src/index.ts" } });
	const parsed = JSON.parse(ws.sent[0]);
	expect(parsed.type).toBe("tool_call");
	expect(parsed.id).toBe("call_1");
	expect(parsed.name).toBe("read_file");
	expect(parsed.arguments.path).toBe("src/index.ts");
});

test("send encodes tool_result message", () => {
	const ws = mockWs();
	send(ws, { type: "tool_result", id: "call_1", name: "read_file", output: "file contents" });
	const parsed = JSON.parse(ws.sent[0]);
	expect(parsed.type).toBe("tool_result");
	expect(parsed.output).toBe("file contents");
});

test("send encodes tool_result with isError", () => {
	const ws = mockWs();
	send(ws, { type: "tool_result", id: "call_1", name: "read_file", output: "not found", isError: true });
	const parsed = JSON.parse(ws.sent[0]);
	expect(parsed.isError).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/protocol.test.ts`
Expected: FAIL — new types don't exist.

**Step 3: Write the implementation**

Update `packages/server/src/protocol.ts`:

```typescript
// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/protocol.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add tool_call and tool_result to WebSocket protocol
```

---

### Task 7: Message Model & Persistence — Metadata Column

**Files:**
- Modify: `packages/server/src/project.ts` (add `metadata` column to schema)
- Modify: `packages/server/src/session/repository.ts` (support metadata in appendMessage, include in getMessages)
- Modify: `packages/server/test/helpers.ts` (add `metadata` column to test schema)
- Test: `packages/server/test/repository.test.ts` (add tests for metadata and new roles)

This task adds a nullable `metadata TEXT` column to the messages table. For assistant messages with tool_calls, metadata stores `{ tool_calls: [...] }`. For tool result messages, metadata stores `{ tool_call_id: "..." }`. The `appendMessage` function gains expanded role support and an optional metadata parameter. `StoredMessage` gains a `metadata` field.

**Step 1: Write the failing tests**

Add to `packages/server/test/repository.test.ts`:

```typescript
test("appendMessage stores and retrieves metadata", () => {
	const session = createSession(db, "sys");
	const toolCalls = [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }];
	appendMessage(db, session.id, "assistant", "", { tool_calls: toolCalls });

	const messages = getMessages(db, session.id);
	const assistantMsg = messages.find((m) => m.role === "assistant");
	expect(assistantMsg).toBeTruthy();
	expect(assistantMsg!.metadata).toEqual({ tool_calls: toolCalls });
});

test("appendMessage supports tool role with tool_call_id metadata", () => {
	const session = createSession(db, "sys");
	appendMessage(db, session.id, "tool", "file contents", { tool_call_id: "call_1" });

	const messages = getMessages(db, session.id);
	const toolMsg = messages.find((m) => m.role === "tool");
	expect(toolMsg).toBeTruthy();
	expect(toolMsg!.content).toBe("file contents");
	expect(toolMsg!.metadata).toEqual({ tool_call_id: "call_1" });
});

test("appendMessage returns null metadata when none provided", () => {
	const session = createSession(db, "sys");
	appendMessage(db, session.id, "user", "hello");
	const messages = getMessages(db, session.id);
	const userMsg = messages.find((m) => m.role === "user");
	expect(userMsg!.metadata).toBeNull();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/repository.test.ts`
Expected: FAIL — metadata column doesn't exist, appendMessage doesn't accept new args.

**Step 3: Write the implementation**

**3a.** Update `packages/server/src/project.ts` — add `metadata TEXT` column to the messages table:

```sql
CREATE TABLE IF NOT EXISTS messages (
	id         TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions(id),
	role       TEXT NOT NULL,
	content    TEXT NOT NULL,
	created_at TEXT NOT NULL,
	sort_order INTEGER NOT NULL,
	metadata   TEXT
)
```

**3b.** Update `packages/server/test/helpers.ts` — add same `metadata TEXT` column to test schema.

**3c.** Update `packages/server/src/session/repository.ts`:

- Expand `StoredMessage.role` to `"system" | "user" | "assistant" | "tool"`.
- Add `metadata: Record<string, unknown> | null` to `StoredMessage`.
- Update `MessageRow` to include `metadata: string | null`.
- Update `appendMessage` signature: `appendMessage(db, sessionId, role: "user" | "assistant" | "tool", content: string, metadata?: Record<string, unknown>)`.
- In the INSERT statement, add `metadata` column. Store `metadata ? JSON.stringify(metadata) : null`.
- In `getMessages`, read `metadata` column and parse: `metadata: r.metadata ? JSON.parse(r.metadata) : null`.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/repository.test.ts`
Expected: PASS.

Then run all tests to verify nothing broke:

Run: `bun test packages/server/test/`
Expected: All tests pass.

**Step 5: Commit**

```
feat(server): add metadata column to messages table for tool call data
```

---

### Task 8: Agent Loop

**Files:**
- Create: `packages/server/src/agent-loop.ts`
- Test: `packages/server/test/agent-loop.test.ts`

The agent loop is the core of tool usage. It:
1. Calls the provider with the current message history (including tool definitions)
2. Accumulates the response (text chunks and/or tool calls)
3. If the finish reason is `tool_calls`, executes each tool call sequentially
4. Appends the assistant message (with tool_calls metadata) and tool result messages to the conversation
5. Emits events via an `onEvent` callback for the handler to forward to the client
6. Loops back to step 1
7. If the finish reason is `stop`, appends the final assistant text message and returns

Safety: max 20 iterations to prevent runaway loops.

**Step 1: Write the failing tests**

Create `packages/server/test/agent-loop.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runAgentLoop } from "../src/agent-loop";
import type { AgentEvent } from "../src/agent-loop";
import type { Message, Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createToolRegistry } from "../src/tool/tool";
import type { Tool, ToolContext, ToolResult } from "../src/tool/tool";

function textProvider(tokens: string[]): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

/** Provider that returns tool_calls on the first call and text on the second */
function toolThenTextProvider(toolCallId: string, toolName: string, toolArgs: string, secondResponse: string[]): Provider {
	let callCount = 0;
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			if (callCount === 1) {
				yield { type: "tool_call_start", index: 0, id: toolCallId, name: toolName };
				yield { type: "tool_call_delta", index: 0, arguments: toolArgs };
				yield { type: "finish", reason: "tool_calls" };
			} else {
				for (const t of secondResponse) yield { type: "text", text: t };
				yield { type: "finish", reason: "stop" };
			}
		},
	};
}

function echoTool(): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: "echo",
				description: "Echo the input",
				parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
		},
		async execute(args: Record<string, unknown>): Promise<ToolResult> {
			return { output: `echoed: ${args.text}` };
		},
	};
}

describe("runAgentLoop", () => {
	test("returns text response when no tool calls", async () => {
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop({
			provider: textProvider(["Hello", " world"]),
			model: "test",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			onEvent(event) { events.push(event); },
		});

		// Should return the assistant message
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		expect((messages[0] as { content: string }).content).toBe("Hello world");

		// Should have emitted text events
		const textEvents = events.filter((e) => e.type === "text");
		expect(textEvents).toHaveLength(2);
	});

	test("executes tool calls and loops back to provider", async () => {
		const events: AgentEvent[] = [];
		const registry = createToolRegistry([echoTool()]);

		const messages = await runAgentLoop({
			provider: toolThenTextProvider("call_1", "echo", '{"text":"hello"}', ["Done"]),
			model: "test",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "use echo" }],
			tools: registry,
			projectRoot: "/tmp",
			onEvent(event) { events.push(event); },
		});

		// Should return: assistant (tool_calls) + tool result + assistant (text)
		expect(messages).toHaveLength(3);
		expect(messages[0].role).toBe("assistant");
		expect(messages[1].role).toBe("tool");
		expect((messages[1] as { content: string }).content).toBe("echoed: hello");
		expect(messages[2].role).toBe("assistant");
		expect((messages[2] as { content: string }).content).toBe("Done");

		// Should have emitted tool_call and tool_result events
		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		expect(toolCallEvents).toHaveLength(1);
		const toolResultEvents = events.filter((e) => e.type === "tool_result");
		expect(toolResultEvents).toHaveLength(1);
	});

	test("handles unknown tool gracefully", async () => {
		const events: AgentEvent[] = [];
		const registry = createToolRegistry([]); // no tools registered

		// Provider requests a tool that doesn't exist
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "tool_call_start", index: 0, id: "call_1", name: "nonexistent" };
				yield { type: "tool_call_delta", index: 0, arguments: "{}" };
				yield { type: "finish", reason: "tool_calls" };
			},
		};

		// Should still work — unknown tool returns an error result back to the LLM
		// But since provider only has one behavior, we need a provider that responds to tool errors
		let callCount = 0;
		const adaptiveProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "nonexistent" };
					yield { type: "tool_call_delta", index: 0, arguments: "{}" };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "I see the error" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const messages = await runAgentLoop({
			provider: adaptiveProvider,
			model: "test",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
			tools: registry,
			projectRoot: "/tmp",
			onEvent(event) { events.push(event); },
		});

		// Tool result should contain error
		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect((toolMsg as { content: string }).content).toContain("Unknown tool");
	});

	test("respects max iterations safety valve", async () => {
		// Provider always requests tool calls — should stop after 20 iterations
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "tool_call_start", index: 0, id: `call_${Math.random()}`, name: "echo" };
				yield { type: "tool_call_delta", index: 0, arguments: '{"text":"loop"}' };
				yield { type: "finish", reason: "tool_calls" };
			},
		};

		const registry = createToolRegistry([echoTool()]);

		const messages = await runAgentLoop({
			provider,
			model: "test",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "loop" }],
			tools: registry,
			projectRoot: "/tmp",
			maxIterations: 3, // Use a small number for testing
			onEvent() {},
		});

		// Should have stopped and the last message should indicate the limit
		// 3 iterations × (1 assistant + 1 tool) = 6, plus a final error message
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.role).toBe("assistant");
		expect((lastMsg as { content: string }).content).toContain("iteration");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `packages/server/src/agent-loop.ts`:

```typescript
import type { AssistantMessage, Message, Provider, StreamEvent, ToolCallContent, ToolMessage } from "./provider/provider";
import type { ToolRegistry } from "./tool/tool";

const DEFAULT_MAX_ITERATIONS = 20;

export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean };

export interface AgentLoopOptions {
	provider: Provider;
	model: string;
	messages: Message[];
	tools: ToolRegistry;
	projectRoot: string;
	maxIterations?: number;
	onEvent: (event: AgentEvent) => void;
}

interface AccumulatedToolCall {
	id: string;
	name: string;
	arguments: string;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<Message[]> {
	const { provider, model, tools, projectRoot, onEvent } = options;
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	// Working copy of messages — starts with what was passed in
	const conversation = [...options.messages];
	// New messages produced by this loop (what we return)
	const newMessages: Message[] = [];

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		let textContent = "";
		const toolCalls = new Map<number, AccumulatedToolCall>();
		let finishReason: "stop" | "tool_calls" = "stop";

		// Call the provider
		for await (const event of provider.stream({
			model,
			messages: conversation,
			tools: tools.definitions.length > 0 ? tools.definitions : undefined,
		})) {
			switch (event.type) {
				case "text":
					textContent += event.text;
					onEvent({ type: "text", text: event.text });
					break;
				case "tool_call_start":
					toolCalls.set(event.index, { id: event.id, name: event.name, arguments: "" });
					break;
				case "tool_call_delta": {
					const tc = toolCalls.get(event.index);
					if (tc) tc.arguments += event.arguments;
					break;
				}
				case "finish":
					finishReason = event.reason;
					break;
			}
		}

		if (finishReason === "stop" || toolCalls.size === 0) {
			// Normal text response — done
			const assistantMsg: AssistantMessage = { role: "assistant", content: textContent };
			conversation.push(assistantMsg);
			newMessages.push(assistantMsg);
			return newMessages;
		}

		// Tool calls response — build assistant message with tool_calls
		const toolCallContents: ToolCallContent[] = [];
		for (const [, tc] of toolCalls) {
			toolCallContents.push({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: tc.arguments },
			});
		}

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: textContent || null,
			tool_calls: toolCallContents,
		};
		conversation.push(assistantMsg);
		newMessages.push(assistantMsg);

		// Execute each tool call sequentially
		for (const tc of toolCallContents) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				args = {};
			}

			onEvent({ type: "tool_call", id: tc.id, name: tc.function.name, arguments: args });

			const tool = tools.get(tc.function.name);
			let output: string;
			let isError: boolean | undefined;

			if (!tool) {
				output = `Unknown tool: ${tc.function.name}`;
				isError = true;
			} else {
				const result = await tool.execute(args, { projectRoot });
				output = result.output;
				isError = result.isError;
			}

			onEvent({ type: "tool_result", id: tc.id, name: tc.function.name, output, isError });

			const toolMsg: ToolMessage = { role: "tool", content: output, tool_call_id: tc.id };
			conversation.push(toolMsg);
			newMessages.push(toolMsg);
		}

		// Loop continues — provider will be called again with updated conversation
	}

	// Hit max iterations — append a warning message
	const warningMsg: AssistantMessage = {
		role: "assistant",
		content: `Stopped after ${maxIterations} iteration${maxIterations === 1 ? "" : "s"} — possible runaway loop.`,
	};
	conversation.push(warningMsg);
	newMessages.push(warningMsg);
	return newMessages;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): add agent loop for LLM↔tool execution cycle
```

---

### Task 9: Handler Integration — Wire Agent Loop into handlePrompt

**Files:**
- Modify: `packages/server/src/handler.ts`
- Modify: `packages/server/src/server.ts` (pass `projectRoot` through to handler)
- Modify: `packages/server/src/index.ts` (pass `projectRoot` to createServer)
- Modify: `packages/server/test/handler.test.ts` (update tests for new signature and agent loop behavior)
- Modify: `packages/server/test/session.test.ts` (update for new ServerOptions)

The handler currently calls `provider.stream()` directly and concatenates text. Replace this with `runAgentLoop()`. The handler becomes simpler — it delegates the multi-turn loop to the agent loop and uses the `onEvent` callback to forward events to the WebSocket.

**Step 1: Update handler.ts**

The new `PromptRequest` gains a `projectRoot: string` field. The handler:
1. Resolves/creates the session (same as before)
2. Persists the user message (same as before)
3. Loads full history (same as before)
4. Creates a tool registry with `readFileTool` and `listDirectoryTool`
5. Calls `runAgentLoop()` with an `onEvent` callback that calls `send(ws, ...)` for each event type
6. Persists all new messages returned by the agent loop (assistant messages with optional metadata, tool messages with metadata)
7. Sends `done`

```typescript
import type { Database } from "bun:sqlite";
import { runAgentLoop } from "./agent-loop";
import type { AgentEvent } from "./agent-loop";
import { send } from "./protocol";
import type { AssistantMessage, Message, Provider, ToolMessage } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import { appendMessage, createSession, getMessages, getSession } from "./session/repository";
import { SYSTEM_PROMPT } from "./system-prompt";
import { listDirectoryTool } from "./tool/list-directory";
import { readFileTool } from "./tool/read-file";
import { createToolRegistry } from "./tool/tool";

export interface PromptRequest {
	ws: { send: (msg: string) => void };
	db: Database;
	provider: Provider;
	model: string;
	text: string;
	sessionId?: string;
	projectRoot: string;
}

export async function handlePrompt(req: PromptRequest) {
	const { ws, db, provider, model, text, sessionId, projectRoot } = req;

	let currentSessionId: string | undefined;

	try {
		// Resolve or create session
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

		// Load full conversation history and convert to Message[]
		const stored = getMessages(db, currentSessionId);
		const messages: Message[] = stored.map((m) => {
			if (m.role === "tool" && m.metadata?.tool_call_id) {
				return { role: "tool", content: m.content, tool_call_id: m.metadata.tool_call_id as string };
			}
			if (m.role === "assistant" && m.metadata?.tool_calls) {
				return { role: "assistant", content: m.content || null, tool_calls: m.metadata.tool_calls as AssistantMessage["tool_calls"] };
			}
			return { role: m.role as "system" | "user" | "assistant", content: m.content };
		});

		const tools = createToolRegistry([readFileTool, listDirectoryTool]);

		// Run the agent loop
		const newMessages = await runAgentLoop({
			provider,
			model,
			messages,
			tools,
			projectRoot,
			onEvent(event: AgentEvent) {
				if (event.type === "text") {
					send(ws, { type: "token", text: event.text });
				} else if (event.type === "tool_call") {
					send(ws, { type: "tool_call", id: event.id, name: event.name, arguments: event.arguments });
				} else if (event.type === "tool_result") {
					send(ws, { type: "tool_result", id: event.id, name: event.name, output: event.output, isError: event.isError });
				}
			},
		});

		// Persist all new messages
		for (const msg of newMessages) {
			if (msg.role === "assistant") {
				const am = msg as AssistantMessage;
				const metadata = am.tool_calls ? { tool_calls: am.tool_calls } : undefined;
				appendMessage(db, currentSessionId, "assistant", am.content ?? "", metadata);
			} else if (msg.role === "tool") {
				const tm = msg as ToolMessage;
				appendMessage(db, currentSessionId, "tool", tm.content, { tool_call_id: tm.tool_call_id });
			}
		}

		send(ws, { type: "done", sessionId: currentSessionId });
	} catch (err) {
		const message =
			err instanceof ProviderError ? `Provider error (${err.status}): ${err.body}` : "Unexpected error during generation";
		send(ws, { type: "error", message });
	}
}
```

Note: The old partial-response-on-error behavior (saving `fullResponse` when provider errors mid-stream) is naturally handled by the agent loop — the loop will throw on provider errors, and the catch block handles it. The partial persistence is no longer needed because the agent loop accumulates internally and only returns completed messages.

**Step 2: Update server.ts**

Add `projectRoot: string` to `ServerOptions`. Pass it through to `handlePrompt`:

```typescript
export interface ServerOptions {
	port: number;
	staticDir?: string;
	db?: Database;
	provider?: Provider;
	model?: string;
	projectRoot?: string;
}
```

In the websocket message handler, pass `projectRoot: options.projectRoot ?? process.cwd()`:

```typescript
handlePrompt({
	ws,
	db: options.db,
	provider: options.provider,
	model: options.model,
	text: msg.text,
	sessionId: msg.sessionId,
	projectRoot: options.projectRoot ?? process.cwd(),
})
```

**Step 3: Update index.ts**

Pass `projectRoot: process.cwd()` to `createServer`:

```typescript
const server = createServer({ port, staticDir, db: project.db, provider, model: config.model, projectRoot: process.cwd() });
```

**Step 4: Update handler.test.ts**

The handler tests need significant updates:
- All `handlePrompt` calls need `projectRoot: "/tmp"` added.
- The mock providers need to yield `StreamEvent` objects instead of `string` (this may already be done in Task 1 step 5, verify).
- The `partialFailingProvider` test may need adjustment since partial error persistence changed.
- Add a new test that verifies tool calls are executed and persisted.

Key changes to handler.test.ts:
- Add `projectRoot: "/tmp"` to every `handlePrompt` call.
- Add a test: "executes tool calls and persists tool messages" — use a `toolThenTextProvider` that requests a tool call, verify the DB contains assistant (with metadata), tool, and final assistant messages.
- Update the partial-failing test to account for the fact that errors now propagate differently through the agent loop.

**Step 5: Update session.test.ts**

Add `projectRoot: "/tmp"` to `ServerOptions` in `createServer`.

**Step 6: Run all tests**

Run: `bun test packages/server/test/`
Expected: All tests pass.

**Step 7: Commit**

```
feat(server): integrate agent loop into handler for tool execution
```

---

### Task 10: System Prompt Update

**Files:**
- Modify: `packages/server/src/system-prompt.ts`
- Modify: `packages/server/test/system-prompt.test.ts`

**Step 1: Update the tests**

Update `packages/server/test/system-prompt.test.ts`:

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

	test("mentions available tools", () => {
		expect(SYSTEM_PROMPT).toContain("read_file");
		expect(SYSTEM_PROMPT).toContain("list_directory");
	});

	test("does not claim inability to read files", () => {
		expect(SYSTEM_PROMPT).not.toContain("cannot read");
		expect(SYSTEM_PROMPT).not.toContain("cannot modify");
		expect(SYSTEM_PROMPT).not.toContain("no access to the project");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: FAIL — old prompt still mentions limitations.

**Step 3: Write the implementation**

Update `packages/server/src/system-prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `You are Bob AI, a coding assistant.

You help developers write, understand, debug, and improve code. You give clear, direct answers. When a question is ambiguous, you ask for clarification rather than guess.

You have access to the following tools:
- read_file: Read the contents of a file in the user's project.
- list_directory: List the contents of a directory in the user's project.

Use these tools to explore the codebase when the user asks about their code. Read files to understand context before answering questions about specific code.`;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: PASS.

**Step 5: Commit**

```
feat(server): update system prompt with tool descriptions
```

---

### Task 11: Frontend — Handle tool_call and tool_result Messages

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts`
- Modify: `packages/ui/src/App.tsx`

This task adds frontend handling for the new `tool_call` and `tool_result` WebSocket messages. Tool calls are rendered inline within the assistant's message stream as status blocks.

**Step 1: Update useWebSocket.ts**

Add `tool_call` and `tool_result` to the `ServerMessage` type. When a `tool_call` message arrives, append a status line to the current assistant message like `\n[Calling read_file...]\n`. When a `tool_result` arrives, optionally append a brief status like `[read_file completed]\n`. The text tokens that follow will continue the assistant message.

Updated `ServerMessage` type:

```typescript
type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean }
	| { type: "done"; sessionId: string }
	| { type: "error"; message: string };
```

Add handlers in the `onmessage` callback:

```typescript
if (msg.type === "tool_call") {
	setMessages((prev) => {
		const last = prev.at(-1);
		const status = `\n[Calling ${msg.name}...]\n`;
		if (last?.role === "assistant") {
			return [...prev.slice(0, -1), { role: "assistant", text: last.text + status }];
		}
		return [...prev, { role: "assistant", text: status }];
	});
}

if (msg.type === "tool_result") {
	setMessages((prev) => {
		const last = prev.at(-1);
		const status = msg.isError ? `[${msg.name} failed]\n` : `[${msg.name} done]\n`;
		if (last?.role === "assistant") {
			return [...prev.slice(0, -1), { role: "assistant", text: last.text + status }];
		}
		return [...prev, { role: "assistant", text: status }];
	});
}
```

**Step 2: Update App.tsx**

No structural changes needed — the existing message rendering already handles the text content which now includes inline tool status blocks. The `whiteSpace: "pre-wrap"` style already preserves the newlines.

**Step 3: Build the UI**

Run: `bun run build` from `packages/ui/`

Expected: Build succeeds.

**Step 4: Commit**

```
feat(ui): display tool call status in chat messages
```

---

### Task 12: Final Integration Test and Cleanup

**Files:**
- Test: all existing test files
- Verify: `bun test packages/server/test/`

**Step 1: Run the full test suite**

Run: `bun test packages/server/test/`
Expected: All tests pass (should be more than the original 106).

**Step 2: Run Biome formatting**

Run: `bunx biome check --write packages/server/src/ packages/server/test/ packages/ui/src/`
Expected: No issues or all auto-fixed.

**Step 3: Run Biome lint**

Run: `bunx biome lint packages/server/src/ packages/server/test/ packages/ui/src/`
Expected: No errors.

**Step 4: Manual smoke test (optional)**

Start the server and verify tool usage works end-to-end:
- Ask "What files are in this project?" — should trigger `list_directory`
- Ask "Read the package.json" — should trigger `read_file`
- Verify the tool status messages appear in the UI

**Step 5: Commit if any cleanup was needed**

```
chore: format and lint cleanup after tool usage implementation
```
