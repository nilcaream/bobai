# Full Agent Toolset Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Transform Bob AI from a read-only assistant into a fully capable coding agent that can read, write, search, and execute commands.

**Architecture:** Four new tools (`write_file`, `edit_file`, `grep_search`, `bash`) follow the existing `Tool` interface pattern. Each tool validates paths against `projectRoot`, returns structured `ToolResult` objects, and is registered in the handler's `createToolRegistry` call. The system prompt expands to describe all six tools with usage guidance.

**Tech Stack:** Bun runtime, TypeScript, `node:fs` for file operations, `Bun.spawn` for subprocess execution, `bun:test` for testing.

**Run tests:** `bun test packages/server/test/`

---

### Task 1: write_file tool

**Files:**
- Create: `packages/server/src/tool/write-file.ts`
- Test: `packages/server/test/write-file.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/write-file.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileTool } from "../src/tool/write-file";
import type { ToolContext } from "../src/tool/tool";

describe("writeFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-write-file-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "existing.txt"), "original content");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(writeFileTool.definition.function.name).toBe("write_file");
		expect(writeFileTool.definition.function.parameters.required).toContain("path");
		expect(writeFileTool.definition.function.parameters.required).toContain("content");
	});

	test("creates a new file", async () => {
		const result = await writeFileTool.execute({ path: "new-file.txt", content: "hello world" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("new-file.txt");
		const written = fs.readFileSync(path.join(tmpDir, "new-file.txt"), "utf-8");
		expect(written).toBe("hello world");
	});

	test("overwrites an existing file", async () => {
		const result = await writeFileTool.execute({ path: "existing.txt", content: "new content" }, ctx);
		expect(result.isError).toBeUndefined();
		const written = fs.readFileSync(path.join(tmpDir, "existing.txt"), "utf-8");
		expect(written).toBe("new content");
	});

	test("creates parent directories automatically", async () => {
		const result = await writeFileTool.execute({ path: "deep/nested/dir/file.txt", content: "deep" }, ctx);
		expect(result.isError).toBeUndefined();
		const written = fs.readFileSync(path.join(tmpDir, "deep/nested/dir/file.txt"), "utf-8");
		expect(written).toBe("deep");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await writeFileTool.execute({ path: "../../etc/evil", content: "bad" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when path is missing", async () => {
		const result = await writeFileTool.execute({ content: "hello" }, ctx);
		expect(result.isError).toBe(true);
	});

	test("returns error when content is missing", async () => {
		const result = await writeFileTool.execute({ path: "foo.txt" }, ctx);
		expect(result.isError).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/write-file.test.ts`
Expected: FAIL — cannot import `writeFileTool`

**Step 3: Write the implementation**

Create `packages/server/src/tool/write-file.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const writeFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "write_file",
			description: "Create or overwrite a file. The path is relative to the project root. Parent directories are created automatically.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
					content: {
						type: "string",
						description: "The content to write to the file",
					},
				},
				required: ["path", "content"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}
		const content = args.content;
		if (typeof content !== "string") {
			return { output: "Error: 'content' argument is required and must be a string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		try {
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, content, "utf-8");
			return { output: `Wrote ${content.length} bytes to ${filePath}` };
		} catch (err) {
			return { output: `Error writing file: ${(err as Error).message}`, isError: true };
		}
	},
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/write-file.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```
feat(server): add write_file tool
```

---

### Task 2: edit_file tool

**Files:**
- Create: `packages/server/src/tool/edit-file.ts`
- Test: `packages/server/test/edit-file.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/edit-file.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../src/tool/edit-file";
import type { ToolContext } from "../src/tool/tool";

describe("editFileTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-edit-file-"));
		ctx = { projectRoot: tmpDir };
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name and parameters", () => {
		expect(editFileTool.definition.function.name).toBe("edit_file");
		const params = editFileTool.definition.function.parameters;
		expect(params.required).toContain("path");
		expect(params.required).toContain("old_string");
		expect(params.required).toContain("new_string");
	});

	test("replaces a unique string in a file", async () => {
		fs.writeFileSync(path.join(tmpDir, "target.ts"), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
		const result = await editFileTool.execute(
			{ path: "target.ts", old_string: "const y = 2;", new_string: "const y = 42;" },
			ctx,
		);
		expect(result.isError).toBeUndefined();
		const content = fs.readFileSync(path.join(tmpDir, "target.ts"), "utf-8");
		expect(content).toBe('const x = 1;\nconst y = 42;\nconst z = 3;\n');
		expect(result.output).toContain("target.ts");
	});

	test("returns error when old_string is not found", async () => {
		fs.writeFileSync(path.join(tmpDir, "no-match.ts"), "hello world\n");
		const result = await editFileTool.execute(
			{ path: "no-match.ts", old_string: "does not exist", new_string: "replacement" },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("returns error when old_string has multiple matches", async () => {
		fs.writeFileSync(path.join(tmpDir, "multi.ts"), "foo\nbar\nfoo\n");
		const result = await editFileTool.execute(
			{ path: "multi.ts", old_string: "foo", new_string: "baz" },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("multiple");
	});

	test("returns error for nonexistent file", async () => {
		const result = await editFileTool.execute(
			{ path: "nope.ts", old_string: "x", new_string: "y" },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await editFileTool.execute(
			{ path: "../../etc/passwd", old_string: "root", new_string: "hacked" },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when required args are missing", async () => {
		const r1 = await editFileTool.execute({ old_string: "x", new_string: "y" }, ctx);
		expect(r1.isError).toBe(true);
		const r2 = await editFileTool.execute({ path: "f.ts", new_string: "y" }, ctx);
		expect(r2.isError).toBe(true);
		const r3 = await editFileTool.execute({ path: "f.ts", old_string: "x" }, ctx);
		expect(r3.isError).toBe(true);
	});

	test("shows context around the edit in output", async () => {
		fs.writeFileSync(path.join(tmpDir, "context.ts"), "line1\nline2\nline3\nline4\nline5\n");
		const result = await editFileTool.execute(
			{ path: "context.ts", old_string: "line3", new_string: "LINE_THREE" },
			ctx,
		);
		expect(result.isError).toBeUndefined();
		// Output should show surrounding lines for context
		expect(result.output).toContain("LINE_THREE");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/edit-file.test.ts`
Expected: FAIL — cannot import `editFileTool`

**Step 3: Write the implementation**

Create `packages/server/src/tool/edit-file.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const editFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "edit_file",
			description:
				"Edit a file by replacing a specific string with new content. The old_string must match exactly one location in the file. Include enough surrounding context in old_string to make it unique.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
					old_string: {
						type: "string",
						description: "The exact string to find and replace. Must match exactly one location in the file.",
					},
					new_string: {
						type: "string",
						description: "The string to replace old_string with",
					},
				},
				required: ["path", "old_string", "new_string"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}
		const oldString = args.old_string;
		if (typeof oldString !== "string") {
			return { output: "Error: 'old_string' argument is required and must be a string", isError: true };
		}
		const newString = args.new_string;
		if (typeof newString !== "string") {
			return { output: "Error: 'new_string' argument is required and must be a string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		let content: string;
		try {
			content = fs.readFileSync(resolved, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: file not found: ${filePath}`, isError: true };
			}
			return { output: `Error reading file: ${(err as Error).message}`, isError: true };
		}

		// Count occurrences
		let count = 0;
		let idx = 0;
		while ((idx = content.indexOf(oldString, idx)) !== -1) {
			count++;
			idx += oldString.length;
		}

		if (count === 0) {
			return { output: `Error: old_string not found in ${filePath}`, isError: true };
		}
		if (count > 1) {
			return {
				output: `Error: old_string found ${count} times in ${filePath}. Include more surrounding context to make the match unique.`,
				isError: true,
			};
		}

		// Perform the replacement
		const newContent = content.replace(oldString, newString);
		fs.writeFileSync(resolved, newContent, "utf-8");

		// Show context around the edit
		const editIdx = newContent.indexOf(newString);
		const lines = newContent.split("\n");
		let editLine = 0;
		let charCount = 0;
		for (let i = 0; i < lines.length; i++) {
			charCount += lines[i].length + 1; // +1 for newline
			if (charCount > editIdx) {
				editLine = i;
				break;
			}
		}
		const ctxStart = Math.max(0, editLine - 3);
		const ctxEnd = Math.min(lines.length, editLine + newString.split("\n").length + 3);
		const contextLines = lines.slice(ctxStart, ctxEnd).map((l, i) => `${ctxStart + i + 1}: ${l}`);

		return { output: `Edited ${filePath}:\n${contextLines.join("\n")}` };
	},
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/edit-file.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```
feat(server): add edit_file tool
```

---

### Task 3: grep_search tool

**Files:**
- Create: `packages/server/src/tool/grep-search.ts`
- Test: `packages/server/test/grep-search.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/grep-search.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grepSearchTool } from "../src/tool/grep-search";
import type { ToolContext } from "../src/tool/tool";

describe("grepSearchTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-grep-search-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "hello.ts"), 'const greeting = "hello";\nexport default greeting;\n');
		fs.writeFileSync(path.join(tmpDir, "world.ts"), 'const planet = "world";\nexport default planet;\n');
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), 'import greeting from "../hello";\nconsole.log(greeting);\n');
		fs.writeFileSync(path.join(tmpDir, "src", "app.css"), 'body { color: red; }\n');
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(grepSearchTool.definition.function.name).toBe("grep_search");
	});

	test("finds pattern across files", async () => {
		const result = await grepSearchTool.execute({ pattern: "export default" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello.ts");
		expect(result.output).toContain("world.ts");
	});

	test("scopes search to a subdirectory", async () => {
		const result = await grepSearchTool.execute({ pattern: "import", path: "src" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("app.ts");
		expect(result.output).not.toContain("hello.ts");
	});

	test("filters by file glob with include", async () => {
		const result = await grepSearchTool.execute({ pattern: "body", include: "*.css" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("app.css");
	});

	test("returns message when no matches found", async () => {
		const result = await grepSearchTool.execute({ pattern: "zzz_nonexistent_zzz" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("No matches");
	});

	test("returns error for path traversal attempt", async () => {
		const result = await grepSearchTool.execute({ pattern: "test", path: "../../" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside");
	});

	test("returns error when pattern is missing", async () => {
		const result = await grepSearchTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/grep-search.test.ts`
Expected: FAIL — cannot import `grepSearchTool`

**Step 3: Write the implementation**

Create `packages/server/src/tool/grep-search.ts`:

The implementation uses `Bun.spawn` to run `grep -rn` with optional `--include` flag. The tool falls back to a recursive file-walking search if grep is not available, but in practice grep is always present on Linux.

```typescript
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

const MAX_RESULTS = 100;

export const grepSearchTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "grep_search",
			description:
				"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Searches recursively from the given path (defaults to project root).",
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "The search pattern (regular expression or fixed string)",
					},
					path: {
						type: "string",
						description: "Relative path to search from. Defaults to project root.",
					},
					include: {
						type: "string",
						description: "File glob pattern to filter which files are searched (e.g. '*.ts', '*.{ts,tsx}')",
					},
				},
				required: ["pattern"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const pattern = args.pattern;
		if (typeof pattern !== "string" || pattern.length === 0) {
			return { output: "Error: 'pattern' argument is required and must be a non-empty string", isError: true };
		}

		const searchPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		const resolved = path.resolve(ctx.projectRoot, searchPath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${searchPath}' resolves outside the project root`, isError: true };
		}

		const grepArgs = ["-rn", "--color=never"];
		if (typeof args.include === "string" && args.include.length > 0) {
			grepArgs.push(`--include=${args.include}`);
		}
		grepArgs.push(pattern, ".");

		try {
			const proc = Bun.spawn(["grep", ...grepArgs], {
				cwd: resolved,
				stdout: "pipe",
				stderr: "pipe",
			});

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode === 1 && stdout.length === 0) {
				return { output: "No matches found." };
			}
			if (exitCode > 1) {
				return { output: `Error running grep: ${stderr}`, isError: true };
			}

			const lines = stdout.trimEnd().split("\n");
			if (lines.length > MAX_RESULTS) {
				return {
					output: `${lines.slice(0, MAX_RESULTS).join("\n")}\n\n... truncated (${lines.length} total matches, showing first ${MAX_RESULTS})`,
				};
			}
			return { output: stdout.trimEnd() };
		} catch (err) {
			return { output: `Error running search: ${(err as Error).message}`, isError: true };
		}
	},
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/grep-search.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```
feat(server): add grep_search tool
```

---

### Task 4: bash tool

**Files:**
- Create: `packages/server/src/tool/bash.ts`
- Test: `packages/server/test/bash.test.ts`

**Step 1: Write the failing tests**

Create `packages/server/test/bash.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "../src/tool/bash";
import type { ToolContext } from "../src/tool/tool";

describe("bashTool", () => {
	let tmpDir: string;
	let ctx: ToolContext;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-bash-"));
		ctx = { projectRoot: tmpDir };
		fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello from test");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("definition has correct name", () => {
		expect(bashTool.definition.function.name).toBe("bash");
	});

	test("executes a simple command and returns stdout", async () => {
		const result = await bashTool.execute({ command: "echo 'hello world'" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello world");
	});

	test("runs in projectRoot as working directory", async () => {
		const result = await bashTool.execute({ command: "cat test.txt" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("hello from test");
	});

	test("returns exit code and stderr on failure", async () => {
		const result = await bashTool.execute({ command: "ls nonexistent_dir_12345" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("exit code");
	});

	test("captures both stdout and stderr", async () => {
		const result = await bashTool.execute({ command: "echo 'out' && echo 'err' >&2" }, ctx);
		// Both streams should be in the output
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	test("respects timeout", async () => {
		const result = await bashTool.execute({ command: "sleep 60", timeout: 500 }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out");
	}, 10000);

	test("returns error when command is missing", async () => {
		const result = await bashTool.execute({}, ctx);
		expect(result.isError).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/bash.test.ts`
Expected: FAIL — cannot import `bashTool`

**Step 3: Write the implementation**

Create `packages/server/src/tool/bash.ts`:

```typescript
import type { Tool, ToolContext, ToolResult } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 50_000;

export const bashTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "bash",
			description:
				"Execute a bash command in the project directory. Returns stdout, stderr, and exit code. Use for running tests, builds, linters, git commands, and other shell operations.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The bash command to execute",
					},
					timeout: {
						type: "number",
						description: "Timeout in milliseconds. Defaults to 30000 (30 seconds).",
					},
				},
				required: ["command"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const command = args.command;
		if (typeof command !== "string" || command.length === 0) {
			return { output: "Error: 'command' argument is required and must be a non-empty string", isError: true };
		}

		const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;

		try {
			const proc = Bun.spawn(["/bin/bash", "-c", command], {
				cwd: ctx.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
			const exitPromise = proc.exited;

			const result = await Promise.race([exitPromise.then((code) => ({ kind: "done" as const, code })), timeoutPromise]);

			if (result === "timeout") {
				proc.kill();
				// Collect any partial output
				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				let output = truncate(`${stdout}${stderr}`.trim());
				if (output.length > 0) output += "\n\n";
				output += `Command timed out after ${timeoutMs}ms`;
				return { output, isError: true };
			}

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const combined = `${stdout}${stderr}`.trim();
			const truncated = truncate(combined);

			if (result.code !== 0) {
				return {
					output: `${truncated}\n\nexit code: ${result.code}`,
					isError: true,
				};
			}

			return { output: truncated || "(no output)" };
		} catch (err) {
			return { output: `Error executing command: ${(err as Error).message}`, isError: true };
		}
	},
};

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n... truncated (${text.length} bytes total, showing first ${MAX_OUTPUT_BYTES})`;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/bash.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```
feat(server): add bash tool
```

---

### Task 5: Register all tools in handler

**Files:**
- Modify: `packages/server/src/handler.ts:9-11,61`

**Step 1: Update handler to import and register new tools**

Add imports for the four new tools and include them in the `createToolRegistry` call:

```typescript
// Add imports
import { writeFileTool } from "./tool/write-file";
import { editFileTool } from "./tool/edit-file";
import { grepSearchTool } from "./tool/grep-search";
import { bashTool } from "./tool/bash";

// Update the createToolRegistry call (line 61)
const tools = createToolRegistry([readFileTool, listDirectoryTool, writeFileTool, editFileTool, grepSearchTool, bashTool]);
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `bun test packages/server/test/`
Expected: All tests PASS (existing handler tests still work because mock providers don't call the new tools)

**Step 3: Commit**

```
feat(server): register all tools in handler
```

---

### Task 6: Update system prompt

**Files:**
- Modify: `packages/server/src/system-prompt.ts`
- Modify: `packages/server/test/system-prompt.test.ts`

**Step 1: Update tests to check for new tools**

Add assertions for the four new tool names in `system-prompt.test.ts`:

```typescript
test("mentions available tools", () => {
	expect(SYSTEM_PROMPT).toContain("read_file");
	expect(SYSTEM_PROMPT).toContain("list_directory");
	expect(SYSTEM_PROMPT).toContain("write_file");
	expect(SYSTEM_PROMPT).toContain("edit_file");
	expect(SYSTEM_PROMPT).toContain("grep_search");
	expect(SYSTEM_PROMPT).toContain("bash");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: FAIL — new tool names not in prompt

**Step 3: Update system prompt**

Replace the system prompt with expanded instructions:

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

When working with code:
- Use grep_search to find relevant code before reading entire files.
- Read files to understand context before making changes.
- Use edit_file for modifying existing files and write_file for creating new ones.
- After making changes, run relevant tests or builds to verify correctness.`;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/system-prompt.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```
feat(server): update system prompt with all tool descriptions
```

---

### Task 7: Integration test

**Files:**
- Modify: `packages/server/test/agent-loop.test.ts`

**Step 1: Add a multi-tool workflow test**

Add a new test to `agent-loop.test.ts` that simulates a multi-step tool usage pattern: the LLM reads a file, then edits it. This exercises the loop making multiple iterations.

```typescript
test("handles multi-tool workflow (read then edit)", async () => {
	let callCount = 0;
	const multiProvider: Provider = {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			if (callCount === 1) {
				// First: LLM calls read_file
				yield { type: "tool_call_start", index: 0, id: "call_read", name: "read_file" };
				yield { type: "tool_call_delta", index: 0, arguments: '{"path":"test.txt"}' };
				yield { type: "finish", reason: "tool_calls" };
			} else if (callCount === 2) {
				// Second: LLM calls edit_file
				yield { type: "tool_call_start", index: 0, id: "call_edit", name: "edit_file" };
				yield {
					type: "tool_call_delta",
					index: 0,
					arguments: '{"path":"test.txt","old_string":"hello","new_string":"goodbye"}',
				};
				yield { type: "finish", reason: "tool_calls" };
			} else {
				// Third: LLM responds with text
				yield { type: "text", text: "I updated the file." };
				yield { type: "finish", reason: "stop" };
			}
		},
	};

	// Create a temp dir with a test file
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-integration-"));
	fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello world");

	const events: AgentEvent[] = [];
	const registry = createToolRegistry([readFileTool, editFileTool]);

	const messages = await runAgentLoop({
		provider: multiProvider,
		model: "test",
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "update the file" },
		],
		tools: registry,
		projectRoot: tmpDir,
		onEvent(event) {
			events.push(event);
		},
	});

	// Should have: assistant(read) + tool(read result) + assistant(edit) + tool(edit result) + assistant(text)
	expect(messages).toHaveLength(5);
	expect(messages[0].role).toBe("assistant"); // read_file call
	expect(messages[1].role).toBe("tool"); // read result
	expect((messages[1] as { content: string }).content).toContain("hello world");
	expect(messages[2].role).toBe("assistant"); // edit_file call
	expect(messages[3].role).toBe("tool"); // edit result
	expect(messages[4].role).toBe("assistant"); // final text
	expect((messages[4] as { content: string }).content).toBe("I updated the file.");

	// Verify the file was actually modified
	const content = fs.readFileSync(path.join(tmpDir, "test.txt"), "utf-8");
	expect(content).toBe("goodbye world");

	// Verify tool_call events were emitted
	const toolCallEvents = events.filter((e) => e.type === "tool_call");
	expect(toolCallEvents).toHaveLength(2);

	fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

This test requires adding imports at the top of `agent-loop.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../src/tool/read-file";
import { editFileTool } from "../src/tool/edit-file";
```

**Step 2: Run tests to verify they pass**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: All tests PASS (5 existing + 1 new)

**Step 3: Run full test suite**

Run: `bun test packages/server/test/`
Expected: All tests PASS

**Step 4: Commit**

```
test(server): add multi-tool integration test for agent loop
```

---

### Task 8: Manual E2E test

**No code changes.** Start the server and test interactively.

**Step 1: Start the server**

```bash
bun run packages/server/src/index.ts
```

**Step 2: Open the UI and test these scenarios**

1. **Read workflow:** Ask "What files are in this project?" — expect list_directory usage
2. **Search workflow:** Ask "Find all files that import from node:fs" — expect grep_search usage
3. **Write workflow:** Ask "Create a file called test-output.txt with the content 'hello bob'" — expect write_file usage
4. **Edit workflow:** Ask "In test-output.txt, change 'hello bob' to 'goodbye bob'" — expect edit_file usage
5. **Bash workflow:** Ask "Run 'ls -la' in the project directory" — expect bash usage
6. **Multi-tool workflow:** Ask "Read package.json and tell me the project name" — expect read_file then text response
7. **Error recovery:** Ask "Read a file called nonexistent-file.xyz" — expect graceful error from read_file, LLM should report the error to the user

**Step 3: Clean up**

Delete any test files created during E2E testing (`test-output.txt`, etc.).
