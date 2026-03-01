# Tool Display Refactor Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Move all tool display logic from the UI to the server so the UI becomes a generic markdown panel renderer with zero tool-specific knowledge.

**Architecture:** Each tool defines `formatCall(args)` returning markdown shown immediately, and `execute()` returns `{ llmOutput, uiOutput, isError, mergeable }` — separate content for LLM and UI. The server protocol sends pre-formatted markdown. The UI renders markdown panels and merges adjacent completed+mergeable tool panels.

**Tech Stack:** TypeScript, Bun, React, react-markdown

---

### Task 1: Refactor Tool Interface and ToolResult

**Files:**
- Modify: `packages/server/src/tool/tool.ts` (all lines)

**Step 1: Write the failing test**

Create `packages/server/test/tool-interface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Tool, ToolResult } from "../src/tool/tool";

describe("Tool interface", () => {
	test("ToolResult has llmOutput, uiOutput, isError, mergeable", () => {
		const result: ToolResult = {
			llmOutput: "file contents here",
			uiOutput: "▸ Reading src/app.ts (150 lines)",
			isError: false,
			mergeable: true,
		};
		expect(result.llmOutput).toBe("file contents here");
		expect(result.uiOutput).toBe("▸ Reading src/app.ts (150 lines)");
		expect(result.isError).toBe(false);
		expect(result.mergeable).toBe(true);
	});

	test("ToolResult uiOutput can be null", () => {
		const result: ToolResult = {
			llmOutput: "Edited file",
			uiOutput: null,
			isError: false,
			mergeable: false,
		};
		expect(result.uiOutput).toBeNull();
	});

	test("Tool interface requires formatCall and mergeable", () => {
		const tool: Tool = {
			definition: {
				type: "function",
				function: {
					name: "test_tool",
					description: "test",
					parameters: { type: "object", properties: {}, required: [] },
				},
			},
			mergeable: true,
			formatCall(args: Record<string, unknown>): string {
				return `▸ Testing ${args.name}`;
			},
			async execute(): Promise<ToolResult> {
				return { llmOutput: "ok", uiOutput: "ok", isError: false, mergeable: true };
			},
		};
		expect(tool.mergeable).toBe(true);
		expect(tool.formatCall({ name: "foo" })).toBe("▸ Testing foo");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/tool-interface.test.ts`
Expected: FAIL — `Tool` interface doesn't have `formatCall` or `mergeable`, `ToolResult` doesn't have `llmOutput`/`uiOutput`

**Step 3: Update the Tool interface**

Replace entire content of `packages/server/src/tool/tool.ts` with:

```ts
import type { ToolDefinition } from "../provider/provider";

export interface ToolContext {
	projectRoot: string;
}

export interface ToolResult {
	llmOutput: string;
	uiOutput: string | null;
	isError?: boolean;
	mergeable: boolean;
}

export interface Tool {
	definition: ToolDefinition;
	mergeable: boolean;
	formatCall(args: Record<string, unknown>): string;
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

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/tool-interface.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/server/src/tool/tool.ts packages/server/test/tool-interface.test.ts
git commit -m "refactor: update Tool interface with formatCall, mergeable, and split ToolResult"
```

---

### Task 2: Migrate read_file Tool

**Files:**
- Modify: `packages/server/src/tool/read-file.ts` (all lines)
- Modify: `packages/server/test/read-file.test.ts:121-124` (metadata test)

**Context:** After Task 1, the `ToolResult` interface has `llmOutput`, `uiOutput`, `mergeable` instead of `output` and `metadata`. The tool needs `mergeable: true` and `formatCall` method.

**Step 1: Update read_file tool implementation**

Add `mergeable` and `formatCall` to the tool object, and change all return statements from `{ output: ..., metadata: ... }` to `{ llmOutput: ..., uiOutput: ..., mergeable: true }`.

In `packages/server/src/tool/read-file.ts`:
- Add after line 35 (`},`), before `async execute`:
```ts
	mergeable: true,

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		const from = typeof args.from === "number" ? args.from : undefined;
		const to = typeof args.to === "number" ? args.to : undefined;
		const range = from || to ? ` (lines ${from ?? 1}-${to ?? "end"})` : "";
		return `▸ Reading ${filePath}${range}`;
	},
```

- Change all error returns from `{ output: "Error: ...", isError: true }` to `{ llmOutput: "Error: ...", uiOutput: "Error: ...", isError: true, mergeable: true }`
- Change the success return (line 112) from:
  `{ output: \`...\`, metadata: { linesRead: outputLines.length, totalLines } }`
  to:
  `{ llmOutput: \`...\`, uiOutput: \`▸ Reading \${filePath} (\${outputLines.length} lines)\`, isError: false, mergeable: true }`

Full list of returns to change:
1. Line 40 (missing path): `{ llmOutput: "Error: 'path'...", uiOutput: "Error: 'path'...", isError: true, mergeable: true }`
2. Line 45 (path traversal): `{ llmOutput: \`Error: path...\`, uiOutput: \`Error: path...\`, isError: true, mergeable: true }`
3. Line 54 (ENOENT): `{ llmOutput: \`Error: file not found: \${filePath}\`, uiOutput: \`▸ Reading \${filePath} — file not found\`, isError: true, mergeable: true }`
4. Line 57 (EISDIR): `{ llmOutput: \`Error: '\${filePath}' is a directory...\`, uiOutput: \`▸ Reading \${filePath} — is a directory\`, isError: true, mergeable: true }`
5. Line 59 (generic error): `{ llmOutput: \`Error reading file: ...\`, uiOutput: \`Error reading file: ...\`, isError: true, mergeable: true }`
6. Line 70 (from beyond EOF): `{ llmOutput: \`Error: 'from'...\`, uiOutput: \`Error: 'from'...\`, isError: true, mergeable: true }`
7. Line 112 (success): `{ llmOutput: \`\${outputLines.join("\\n")}\\n\\n\${footer}\`, uiOutput: \`▸ Reading \${filePath} (\${outputLines.length} lines)\`, isError: false, mergeable: true }`

**Step 2: Update the test**

In `packages/server/test/read-file.test.ts`, change the metadata test (lines 121-124) from:
```ts
	test("returns metadata with linesRead and totalLines", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 10, to: 15 }, ctx);
		expect(result.metadata).toEqual({ linesRead: 6, totalLines: 50 });
	});
```
to:
```ts
	test("returns split llmOutput/uiOutput with mergeable flag", async () => {
		const result = await readFileTool.execute({ path: "multiline.txt", from: 10, to: 15 }, ctx);
		expect(result.llmOutput).toContain("10: line 10");
		expect(result.uiOutput).toBe("▸ Reading multiline.txt (6 lines)");
		expect(result.mergeable).toBe(true);
	});
```

Also update other tests that reference `result.output` to use `result.llmOutput` instead. Specifically:
- All `result.output` references become `result.llmOutput`
- All `result.isError` references stay the same (still exists)

**Step 3: Run tests**

Run: `bun test packages/server/test/read-file.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/read-file.ts packages/server/test/read-file.test.ts
git commit -m "refactor: migrate read_file to new Tool interface with formatCall and split output"
```

---

### Task 3: Migrate write_file Tool

**Files:**
- Modify: `packages/server/src/tool/write-file.ts` (all lines)
- Modify: `packages/server/test/write-file.test.ts:50-54` (metadata test)

**Context:** Same pattern as Task 2. `mergeable: true`, add `formatCall`, change returns.

**Step 1: Update write_file tool**

Add after the definition block:
```ts
	mergeable: true,

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		return `▸ Writing ${filePath}`;
	},
```

Change returns:
1. Missing path: `{ llmOutput: "Error: 'path'...", uiOutput: "Error: 'path'...", isError: true, mergeable: true }`
2. Missing content: `{ llmOutput: "Error: 'content'...", uiOutput: "Error: 'content'...", isError: true, mergeable: true }`
3. Path traversal: `{ llmOutput: \`Error: path...\`, uiOutput: \`Error: path...\`, isError: true, mergeable: true }`
4. Success (line 47): `{ llmOutput: \`Wrote \${content.length} bytes to \${filePath}\`, uiOutput: \`▸ Writing \${filePath} (\${content.length} bytes)\`, isError: false, mergeable: true }`
5. Write error: `{ llmOutput: \`Error writing file: ...\`, uiOutput: \`Error writing file: ...\`, isError: true, mergeable: true }`

**Step 2: Update test**

Change metadata test:
```ts
	test("returns split llmOutput/uiOutput with mergeable flag", async () => {
		const content = "metadata test content";
		const result = await writeFileTool.execute({ path: "meta-test.txt", content }, ctx);
		expect(result.llmOutput).toContain("meta-test.txt");
		expect(result.uiOutput).toBe(`▸ Writing meta-test.txt (${content.length} bytes)`);
		expect(result.mergeable).toBe(true);
	});
```

Update other tests: `result.output` → `result.llmOutput`.

**Step 3: Run tests**

Run: `bun test packages/server/test/write-file.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/write-file.ts packages/server/test/write-file.test.ts
git commit -m "refactor: migrate write_file to new Tool interface with formatCall and split output"
```

---

### Task 4: Migrate list_directory Tool

**Files:**
- Modify: `packages/server/src/tool/list-directory.ts` (all lines)
- Modify: `packages/server/test/list-directory.test.ts:44-47` (metadata test)

**Context:** Same pattern. `mergeable: true`, add `formatCall`, change returns.

**Step 1: Update list_directory tool**

Add after definition:
```ts
	mergeable: true,

	formatCall(args: Record<string, unknown>): string {
		const dir = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		return `▸ Listing ${dir}`;
	},
```

Change returns:
1. Path traversal: `{ llmOutput: \`Error: path...\`, uiOutput: \`Error: path...\`, isError: true, mergeable: true }`
2. Success (line 36): `{ llmOutput: lines.join("\\n"), uiOutput: \`▸ Listing \${dirPath} (\${entries.length} entries)\`, isError: false, mergeable: true }`
3. ENOENT: `{ llmOutput: \`Error: directory not found: \${dirPath}\`, uiOutput: \`▸ Listing \${dirPath} — not found\`, isError: true, mergeable: true }`
4. ENOTDIR: `{ llmOutput: \`Error: '\${dirPath}' is not a directory\`, uiOutput: \`▸ Listing \${dirPath} — not a directory\`, isError: true, mergeable: true }`
5. Generic error: `{ llmOutput: \`Error listing directory: ...\`, uiOutput: \`Error listing directory: ...\`, isError: true, mergeable: true }`

**Step 2: Update test**

Change metadata test:
```ts
	test("returns split llmOutput/uiOutput with mergeable flag", async () => {
		const result = await listDirectoryTool.execute({ path: "." }, ctx);
		expect(result.llmOutput).toContain("file-a.txt");
		expect(result.uiOutput).toBe("▸ Listing . (3 entries)");
		expect(result.mergeable).toBe(true);
	});
```

Update other tests: `result.output` → `result.llmOutput`.

**Step 3: Run tests**

Run: `bun test packages/server/test/list-directory.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/list-directory.ts packages/server/test/list-directory.test.ts
git commit -m "refactor: migrate list_directory to new Tool interface with formatCall and split output"
```

---

### Task 5: Migrate grep_search Tool

**Files:**
- Modify: `packages/server/src/tool/grep-search.ts` (all lines)
- Modify: `packages/server/test/grep-search.test.ts` (no metadata test exists — just update `result.output` refs)

**Context:** Same pattern. `mergeable: true`, add `formatCall`, change returns. grep_search has `metadata: { matchCount }` that gets removed.

**Step 1: Update grep_search tool**

Add after definition:
```ts
	mergeable: true,

	formatCall(args: Record<string, unknown>): string {
		const pattern = typeof args.pattern === "string" ? args.pattern : "?";
		const dir = typeof args.path === "string" ? args.path : ".";
		return `▸ Searching ${pattern} in ${dir}`;
	},
```

Change returns:
1. Missing pattern: `{ llmOutput: "Error: 'pattern'...", uiOutput: "Error: 'pattern'...", isError: true, mergeable: true }`
2. Path traversal: `{ llmOutput: \`Error: path...\`, uiOutput: \`Error: path...\`, isError: true, mergeable: true }`
3. No matches (line 64): `{ llmOutput: "No matches found.", uiOutput: \`▸ Searching \${pattern} in \${searchPath} (no results)\`, isError: false, mergeable: true }`
4. grep error (line 67): `{ llmOutput: \`Error running grep: \${stderr}\`, uiOutput: \`Error running grep: \${stderr}\`, isError: true, mergeable: true }`
5. Truncated results (line 72-75): `{ llmOutput: \`\${lines.slice(0, MAX_RESULTS).join("\\n")}\\n\\n... truncated (\${lines.length} total matches, showing first \${MAX_RESULTS})\`, uiOutput: \`▸ Searching \${pattern} in \${searchPath} (\${lines.length} results)\`, isError: false, mergeable: true }`
6. Normal results (line 77): `{ llmOutput: stdout.trimEnd(), uiOutput: \`▸ Searching \${pattern} in \${searchPath} (\${lines.length} results)\`, isError: false, mergeable: true }`
7. Catch error: `{ llmOutput: \`Error running search: ...\`, uiOutput: \`Error running search: ...\`, isError: true, mergeable: true }`

Note: For returns 5 and 6, we need the `pattern` and `searchPath` variables. `pattern` is already available (validated at line 35). `searchPath` is already the local variable on line 40.

**Step 2: Update test**

Update all `result.output` → `result.llmOutput`.

**Step 3: Run tests**

Run: `bun test packages/server/test/grep-search.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/grep-search.ts packages/server/test/grep-search.test.ts
git commit -m "refactor: migrate grep_search to new Tool interface with formatCall and split output"
```

---

### Task 6: Migrate edit_file Tool

**Files:**
- Modify: `packages/server/src/tool/edit-file.ts` (all lines)
- Modify: `packages/server/test/edit-file.test.ts` (update `result.output` refs)

**Context:** `edit_file` is `mergeable: false` because it shows a diff. `formatCall` generates the `▸ Editing` header plus a ` ```diff ` block with the old/new strings. `uiOutput` is `null` on success (diff is already shown at formatCall time). Error `uiOutput` shows the error.

**Step 1: Update edit_file tool**

Add after definition:
```ts
	mergeable: false,

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		const oldString = typeof args.old_string === "string" ? args.old_string : "";
		const newString = typeof args.new_string === "string" ? args.new_string : "";
		const diffLines: string[] = [];
		for (const line of oldString.split("\n")) {
			diffLines.push(`- ${line}`);
		}
		for (const line of newString.split("\n")) {
			diffLines.push(`+ ${line}`);
		}
		return `▸ Editing ${filePath}\n\n\`\`\`diff\n${diffLines.join("\n")}\n\`\`\``;
	},
```

Change returns:
1. Missing path: `{ llmOutput: "Error: 'path'...", uiOutput: "Error: 'path'...", isError: true, mergeable: false }`
2. Missing old_string: same pattern
3. Missing new_string: same pattern
4. Path traversal: same pattern
5. ENOENT: `{ llmOutput: \`Error: file not found: \${filePath}\`, uiOutput: \`▸ Editing \${filePath} — file not found\`, isError: true, mergeable: false }`
6. Generic read error: same pattern
7. old_string not found: `{ llmOutput: \`Error: old_string not found in \${filePath}\`, uiOutput: \`▸ Editing \${filePath} — old_string not found\`, isError: true, mergeable: false }`
8. Multiple matches: `{ llmOutput: \`Error: old_string found multiple times...\`, uiOutput: \`▸ Editing \${filePath} — multiple matches\`, isError: true, mergeable: false }`
9. Success (line 101): `{ llmOutput: \`Edited \${filePath}:\\n\${contextLines.join("\\n")}\`, uiOutput: null, isError: false, mergeable: false }`

**Step 2: Update test**

Update all `result.output` → `result.llmOutput`.

**Step 3: Run tests**

Run: `bun test packages/server/test/edit-file.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/edit-file.ts packages/server/test/edit-file.test.ts
git commit -m "refactor: migrate edit_file to new Tool interface with formatCall and split output"
```

---

### Task 7: Migrate bash Tool

**Files:**
- Modify: `packages/server/src/tool/bash.ts` (all lines)
- Modify: `packages/server/test/bash.test.ts` (update `result.output` refs)

**Context:** `bash` is `mergeable: false` because it shows command output. `formatCall` shows `` `$ command` ``. `uiOutput` shows `` `$ command` `` + the output in a fenced code block.

**Step 1: Update bash tool**

Add after definition:
```ts
	mergeable: false,

	formatCall(args: Record<string, unknown>): string {
		const command = typeof args.command === "string" ? args.command : "?";
		return `\`$ ${command}\``;
	},
```

Change returns:
1. Missing command: `{ llmOutput: "Error: 'command'...", uiOutput: "Error: 'command'...", isError: true, mergeable: false }`
2. Timeout: `{ llmOutput: output, uiOutput: \`\\\`$ \${command}\\\`\\n\\n\\\`\\\`\\\`\\n\${output}\\n\\\`\\\`\\\`\`, isError: true, mergeable: false }`
3. Non-zero exit: `{ llmOutput: \`\${truncated}\\n\\nexit code: \${result.code}\`, uiOutput: \`\\\`$ \${command}\\\`\\n\\n\\\`\\\`\\\`\\n\${truncated}\\n\\nexit code: \${result.code}\\n\\\`\\\`\\\`\`, isError: true, mergeable: false }`
4. Success: `{ llmOutput: truncated || "(no output)", uiOutput: \`\\\`$ \${command}\\\`\\n\\n\\\`\\\`\\\`\\n\${truncated || "(no output)"}\\n\\\`\\\`\\\`\`, isError: false, mergeable: false }`
5. Catch error: `{ llmOutput: \`Error executing command: ...\`, uiOutput: \`Error executing command: ...\`, isError: true, mergeable: false }`

Note: For the uiOutput formatting, extract a helper function within the tool file:
```ts
function formatBashOutput(command: string, output: string): string {
	return `\`$ ${command}\`\n\n\`\`\`\n${output}\n\`\`\``;
}
```

Then use it:
- Timeout: `uiOutput: formatBashOutput(command, output)`
- Non-zero exit: `uiOutput: formatBashOutput(command, \`\${truncated}\\n\\nexit code: \${result.code}\`)`
- Success: `uiOutput: formatBashOutput(command, truncated || "(no output)")`

**Step 2: Update test**

Update all `result.output` → `result.llmOutput`.

**Step 3: Run tests**

Run: `bun test packages/server/test/bash.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/tool/bash.ts packages/server/test/bash.test.ts
git commit -m "refactor: migrate bash to new Tool interface with formatCall and split output"
```

---

### Task 8: Update Agent Loop and AgentEvent

**Files:**
- Modify: `packages/server/src/agent-loop.ts` (all lines)
- Modify: `packages/server/test/agent-loop.test.ts` (update event assertions and echoTool)

**Context:** After Tasks 1-7, all tools return the new `ToolResult`. The agent loop needs to:
1. Call `tool.formatCall(args)` and emit it as the `tool_call` event output
2. Send `result.llmOutput` to the LLM conversation (ToolMessage)
3. Emit `tool_result` event with `result.uiOutput` and `result.mergeable`
4. Remove `name`, `arguments`, `metadata` from AgentEvent

**Step 1: Update AgentEvent type and agent loop**

In `packages/server/src/agent-loop.ts`, change `AgentEvent` to:

```ts
export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; output: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean };
```

In the tool execution block (lines 96-132), change:

```ts
		for (const tc of toolCallContents) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				args = {};
			}

			const tool = tools.get(tc.function.name);

			// Emit formatCall output
			const callOutput = tool ? tool.formatCall(args) : `[${tc.function.name}]`;
			onEvent({ type: "tool_call", id: tc.id, output: callOutput });

			let llmOutput: string;
			let uiOutput: string | null = null;
			let isError: boolean | undefined;
			let mergeable = false;

			if (!tool) {
				llmOutput = `Unknown tool: ${tc.function.name}`;
				uiOutput = `Unknown tool: ${tc.function.name}`;
				isError = true;
			} else {
				try {
					const result = await tool.execute(args, { projectRoot });
					llmOutput = result.llmOutput;
					uiOutput = result.uiOutput;
					isError = result.isError;
					mergeable = result.mergeable;
				} catch (err) {
					llmOutput = `Tool execution error: ${(err as Error).message}`;
					uiOutput = `Tool execution error: ${(err as Error).message}`;
					isError = true;
				}
			}

			onEvent({ type: "tool_result", id: tc.id, output: uiOutput, mergeable });

			const toolMsg: ToolMessage = { role: "tool", content: llmOutput, tool_call_id: tc.id };
			conversation.push(toolMsg);
			newMessages.push(toolMsg);
			onMessage(toolMsg);
		}
```

**Step 2: Update agent-loop tests**

In `packages/server/test/agent-loop.test.ts`:

1. Update `echoTool` to return new ToolResult shape:
```ts
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
		mergeable: true,
		formatCall(args: Record<string, unknown>): string {
			return `▸ Echo ${args.text}`;
		},
		async execute(args: Record<string, unknown>): Promise<ToolResult> {
			return { llmOutput: `echoed: ${args.text}`, uiOutput: `▸ Echo ${args.text} (done)`, isError: false, mergeable: true };
		},
	};
}
```

2. Update event assertions. The tool_call events now have `output` instead of `name`/`arguments`. The tool_result events now have `output`/`mergeable` instead of `name`/`output`/`isError`/`metadata`. Specifically in the "executes tool calls" test, verify:
```ts
		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		expect(toolCallEvents).toHaveLength(1);
		expect((toolCallEvents[0] as { output: string }).output).toBe("▸ Echo hello");
		const toolResultEvents = events.filter((e) => e.type === "tool_result");
		expect(toolResultEvents).toHaveLength(1);
		expect((toolResultEvents[0] as { output: string }).output).toBe("▸ Echo hello (done)");
```

**Step 3: Run tests**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add packages/server/src/agent-loop.ts packages/server/test/agent-loop.test.ts
git commit -m "refactor: update agent loop to use formatCall and split tool output"
```

---

### Task 9: Update Server Protocol and Handler

**Files:**
- Modify: `packages/server/src/protocol.ts` (all lines)
- Modify: `packages/server/src/handler.ts:74-88` (onEvent callback)
- Modify: `packages/server/test/handler.test.ts:221-237` (tool_call/tool_result assertions)

**Context:** After Task 8, `AgentEvent` has the new shape. The protocol needs to match, and the handler just forwards events.

**Step 1: Update protocol**

Replace `packages/server/src/protocol.ts`:

```ts
// Client → Server
export type ClientMessage = { type: "prompt"; text: string; sessionId?: string };

// Server → Client
export type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; output: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean }
	| { type: "done"; sessionId: string; model: string }
	| { type: "error"; message: string };

export function send(ws: { send: (msg: string) => void }, msg: ServerMessage) {
	ws.send(JSON.stringify(msg));
}
```

**Step 2: Update handler onEvent**

In `packages/server/src/handler.ts`, simplify the `onEvent` callback (lines 74-88):

```ts
			onEvent(event: AgentEvent) {
				if (event.type === "text") {
					send(ws, { type: "token", text: event.text });
				} else if (event.type === "tool_call") {
					send(ws, { type: "tool_call", id: event.id, output: event.output });
				} else if (event.type === "tool_result") {
					send(ws, { type: "tool_result", id: event.id, output: event.output, mergeable: event.mergeable });
				}
			},
```

**Step 3: Update handler test**

In `packages/server/test/handler.test.ts`, the test "executes tool calls and persists tool messages" checks for `tool_call` and `tool_result` messages. Update to verify the new shape:

```ts
		const toolCall = msgs.find((m: { type: string }) => m.type === "tool_call");
		expect(toolCall.output).toBeTruthy(); // pre-formatted markdown
		expect(toolCall.name).toBeUndefined(); // name no longer sent
		const toolResult = msgs.find((m: { type: string }) => m.type === "tool_result");
		expect(toolResult.mergeable).toBe(true); // list_directory is mergeable
```

**Step 4: Run tests**

Run: `bun test packages/server/test/handler.test.ts`
Expected: PASS

**Step 5: Run ALL server tests**

Run: `bun test packages/server/test/`
Expected: ALL PASS (201+ tests)

**Step 6: Commit**

```
git add packages/server/src/protocol.ts packages/server/src/handler.ts packages/server/test/handler.test.ts
git commit -m "refactor: simplify protocol and handler to forward pre-formatted tool output"
```

---

### Task 10: Simplify UI WebSocket Hook

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts` (all lines)

**Context:** After Task 9, the server sends `{ type: "tool_call", id, output }` and `{ type: "tool_result", id, output, mergeable }`. The UI no longer needs to know tool names or format anything. `MessagePart` becomes simpler.

**Step 1: Rewrite useWebSocket.ts**

Replace `packages/ui/src/useWebSocket.ts` with:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage =
	| { type: "token"; text: string }
	| { type: "tool_call"; id: string; output: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean }
	| { type: "done"; sessionId: string; model: string }
	| { type: "error"; message: string };

export type MessagePart =
	| { type: "text"; content: string }
	| { type: "tool_call"; id: string; content: string }
	| { type: "tool_result"; id: string; content: string | null; mergeable: boolean };

export type Message =
	| { role: "user"; text: string; timestamp: string }
	| { role: "assistant"; parts: MessagePart[]; timestamp?: string };

function formatTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Append to the last assistant message's parts, or create a new assistant message. */
function appendPart(prev: Message[], part: MessagePart): Message[] {
	const last = prev.at(-1);
	if (last?.role === "assistant") {
		const updated: Message = { ...last, parts: [...last.parts, part] };
		return [...prev.slice(0, -1), updated];
	}
	return [...prev, { role: "assistant", parts: [part] }];
}

/** Append text to the last text part of the last assistant message, or create one. */
function appendText(prev: Message[], text: string): Message[] {
	const last = prev.at(-1);
	if (last?.role === "assistant" && last.parts.length > 0) {
		const lastPart = last.parts.at(-1);
		if (lastPart?.type === "text") {
			const updatedParts = [...last.parts.slice(0, -1), { type: "text" as const, content: lastPart.content + text }];
			return [...prev.slice(0, -1), { ...last, parts: updatedParts }];
		}
		return appendPart(prev, { type: "text", content: text });
	}
	return [...prev, { role: "assistant", parts: [{ type: "text", content: text }] }];
}

export function useWebSocket() {
	const ws = useRef<WebSocket | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [connected, setConnected] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [model, setModel] = useState<string | null>(null);
	const sessionId = useRef<string | null>(null);

	useEffect(() => {
		const socket = new WebSocket(`ws://${window.location.host}/bobai/ws`);

		socket.onopen = () => setConnected(true);
		socket.onclose = () => setConnected(false);

		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data as string) as ServerMessage;

			if (msg.type === "token") {
				setMessages((prev) => appendText(prev, msg.text));
			}

			if (msg.type === "tool_call") {
				setMessages((prev) => appendPart(prev, { type: "tool_call", id: msg.id, content: msg.output }));
			}

			if (msg.type === "tool_result") {
				setMessages((prev) =>
					appendPart(prev, { type: "tool_result", id: msg.id, content: msg.output, mergeable: msg.mergeable }),
				);
			}

			if (msg.type === "done") {
				sessionId.current = msg.sessionId;
				setModel(msg.model);
				setMessages((prev) => {
					const last = prev.at(-1);
					if (last?.role === "assistant") {
						return [...prev.slice(0, -1), { ...last, timestamp: formatTimestamp() }];
					}
					return prev;
				});
				setIsStreaming(false);
			}

			if (msg.type === "error") {
				setMessages((prev) => appendPart(prev, { type: "text", content: `Error: ${msg.message}` }));
				setIsStreaming(false);
			}
		};

		ws.current = socket;
		return () => socket.close();
	}, []);

	const sendPrompt = useCallback(
		(text: string) => {
			if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
			if (isStreaming) return;
			setIsStreaming(true);
			setMessages((prev) => [...prev, { role: "user", text, timestamp: formatTimestamp() }]);
			const payload: { type: string; text: string; sessionId?: string } = { type: "prompt", text };
			if (sessionId.current) {
				payload.sessionId = sessionId.current;
			}
			ws.current.send(JSON.stringify(payload));
		},
		[isStreaming],
	);

	const newChat = useCallback(() => {
		sessionId.current = null;
		setMessages([]);
		setModel(null);
	}, []);

	return { messages, connected, isStreaming, sendPrompt, newChat, model };
}
```

**Step 2: No test file needed** — this is a React hook, tested through manual E2E.

**Step 3: Commit**

```
git add packages/ui/src/useWebSocket.ts
git commit -m "refactor: simplify useWebSocket to receive pre-formatted tool output"
```

---

### Task 11: Simplify App.tsx — Remove All Tool-Specific Code

**Files:**
- Modify: `packages/ui/src/App.tsx` (all lines)

**Context:** After Task 10, `MessagePart` no longer has `name`, `oldString`, `newString`, `isError`, or `metadata`. The UI can now group parts into panels using a simple two-pass algorithm and render everything as markdown. Delete `UnifiedDiff`, `ToolCall` type, `quietTools`, `formatQuietSuffix`, and the tool-specific rendering branches.

**Step 1: Rewrite groupParts and rendering**

New `Panel` type:
```ts
type Panel =
	| { type: "text"; content: string }
	| { type: "tool"; id: string; content: string; completed: boolean; mergeable: boolean };
```

New `groupParts` function:
```ts
function groupParts(parts: MessagePart[]): Panel[] {
	// Pass 1: Create panels for each part
	const raw: Panel[] = [];
	const toolPanelMap = new Map<string, Panel & { type: "tool" }>();

	for (const part of parts) {
		if (part.type === "text") {
			raw.push({ type: "text", content: part.content });
		} else if (part.type === "tool_call") {
			const panel: Panel & { type: "tool" } = {
				type: "tool",
				id: part.id,
				content: part.content,
				completed: false,
				mergeable: false,
			};
			raw.push(panel);
			toolPanelMap.set(part.id, panel);
		} else if (part.type === "tool_result") {
			const panel = toolPanelMap.get(part.id);
			if (panel) {
				if (part.content !== null) {
					panel.content = part.content;
				}
				panel.completed = true;
				panel.mergeable = part.mergeable;
			}
		}
	}

	// Pass 2: Merge adjacent completed+mergeable tool panels
	const merged: Panel[] = [];
	for (const panel of raw) {
		const prev = merged.at(-1);
		if (
			panel.type === "tool" &&
			panel.completed &&
			panel.mergeable &&
			prev?.type === "tool" &&
			prev.completed &&
			prev.mergeable
		) {
			prev.content = `${prev.content}\n${panel.content}`;
		} else {
			merged.push(panel);
		}
	}

	return merged;
}
```

New rendering in `renderPanels()`:
```ts
	function renderPanels() {
		const elements: React.ReactNode[] = [];
		let key = 0;

		for (const msg of messages) {
			if (msg.role === "user") {
				elements.push(
					<div key={key++} className="panel panel--user">
						{msg.text}
						<div className="panel-status">{msg.timestamp}</div>
					</div>,
				);
				continue;
			}

			const panels = groupParts(msg.parts);
			for (let i = 0; i < panels.length; i++) {
				const panel = panels[i];
				const isLast = i === panels.length - 1;

				if (panel.type === "text") {
					elements.push(
						<div key={key++} className="panel panel--assistant">
							<Markdown>{panel.content}</Markdown>
							{isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{model ? ` | ${model}` : ""}
								</div>
							)}
						</div>,
					);
				} else {
					elements.push(
						<div key={key++} className="panel panel--tool">
							<Markdown>{panel.content}</Markdown>
							{isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{model ? ` | ${model}` : ""}
								</div>
							)}
						</div>,
					);
				}
			}
		}

		return elements;
	}
```

Delete from `App.tsx`:
- `UnifiedDiff` component (lines 6-23)
- `ToolCall` type (line 25)
- Old `Panel` type (lines 27-37)
- `quietTools` set (line 39)
- `formatQuietSuffix` function (lines 41-65)
- Old `groupParts` function (lines 67-116)

**Step 2: Commit**

```
git add packages/ui/src/App.tsx
git commit -m "refactor: simplify App.tsx to generic markdown panel renderer"
```

---

### Task 12: Clean Up CSS — Remove Dead Tool-Specific Styles

**Files:**
- Modify: `packages/ui/src/styles/app.css` (lines 99-128)

**Context:** After Task 11, the `.diff`, `.diff-removed`, `.diff-added`, `.tool-call`, `.tool-result`, and `.tool-result--error` CSS classes are no longer used. All tool content is rendered through the Markdown component. Remove these dead styles.

**Step 1: Delete dead CSS**

Remove these blocks from `packages/ui/src/styles/app.css`:
- `.tool-call` (lines 100-102)
- `.diff` (lines 104-109)
- `.diff-removed` (lines 111-113)
- `.diff-added` (lines 115-117)
- `.tool-result` (lines 119-124)
- `.tool-result--error` (lines 126-128)

**Step 2: Run biome check**

Run: `bunx biome check src/` from `packages/ui/`
Expected: No errors

**Step 3: Commit**

```
git add packages/ui/src/styles/app.css
git commit -m "refactor: remove dead tool-specific CSS classes"
```

---

### Task 13: Run Full Test Suite and Verify

**Files:** None (verification only)

**Step 1: Run all server tests**

Run: `bun test packages/server/test/`
Expected: ALL PASS

**Step 2: Run biome check on UI**

Run from `packages/ui/`: `bunx biome check src/`
Expected: No errors

**Step 3: Run biome check on server**

Run from `packages/server/`: `bunx biome check src/`
Expected: No errors

**Step 4: No commit needed** — this is a verification step.
