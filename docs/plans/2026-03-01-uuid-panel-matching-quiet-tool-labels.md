# UUID Panel Matching + Quiet Tool Label Override

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace index-based panel matching with UUID-based matching, and unify quiet tool behavior so results override the call label.

**Architecture:** Tool call IDs (already flowing through the server protocol) are added to `MessagePart`, used in `groupParts` to match results to their originating call. Quiet tools no longer suppress output — instead, their result updates the call label with a count suffix. grep_search becomes quiet.

**Tech Stack:** TypeScript, React, Bun

---

## Context

### Current Problems

1. `groupParts` uses `.at(-1)` to match `tool_result` to panels — breaks when multiple tool calls create separate panels (e.g., two grep_search calls: both results land on the last panel).
2. grep_search has special-case logic in `groupParts` for label updates via metadata.
3. Quiet tool results are silently suppressed — no feedback that work completed.

### Target Behavior

- **UUID matching:** Every `tool_call` and `tool_result` MessagePart carries `id`. `groupParts` maps results to their originating call by ID.
- **Quiet tool = result overrides label:** When a quiet tool's result arrives, its call label is updated with a count suffix (e.g., `"▸ Reading path"` → `"▸ Reading path (150 lines)"`). No separate result block.
- **grep_search becomes quiet:** It joins the quiet tool set. Same label-override behavior.
- **Errors on quiet tools:** Append `"(error)"` to label. No separate result block.
- **Non-quiet tools unchanged:** bash shows result block, edit_file shows diff.

### File Map

| File | Changes |
|------|---------|
| `packages/server/src/tool/read-file.ts` | Add `metadata: { linesRead, totalLines }` to success returns |
| `packages/server/src/tool/write-file.ts` | Add `metadata: { bytesWritten }` to success return |
| `packages/server/src/tool/list-directory.ts` | Add `metadata: { entryCount }` to success return |
| `packages/server/test/read-file.test.ts` | Test metadata presence |
| `packages/server/test/write-file.test.ts` | Test metadata presence |
| `packages/server/test/list-directory.test.ts` | Test metadata presence |
| `packages/ui/src/useWebSocket.ts` | Add `id` to `MessagePart` types, pass through from `ServerMessage` |
| `packages/ui/src/App.tsx` | Refactor `Panel.calls` to `{ id, label }[]`, ID-based matching in `groupParts`, quiet label override, grep_search → quiet, update rendering |

---

## Task 1: Server — Add metadata to read_file, write_file, list_directory

**Files:**
- Modify: `packages/server/src/tool/read-file.ts` — success returns
- Modify: `packages/server/src/tool/write-file.ts` — success return
- Modify: `packages/server/src/tool/list-directory.ts` — success return
- Modify: `packages/server/test/read-file.test.ts` — add metadata assertions
- Modify: `packages/server/test/write-file.test.ts` — add metadata assertions
- Modify: `packages/server/test/list-directory.test.ts` — add metadata assertions

### read_file changes

Two success return paths in read-file.ts. Both return `{ output: ... }`. Change to include metadata:

```ts
return { output: `${outputLines.join("\n")}\n\n${footer}`, metadata: { linesRead: outputLines.length, totalLines } };
```

### write_file changes

One success return in write-file.ts:

```ts
return { output: `Wrote ${content.length} bytes to ${filePath}`, metadata: { bytesWritten: content.length } };
```

### list_directory changes

One success return in list-directory.ts:

```ts
return { output: lines.join("\n"), metadata: { entryCount: entries.length } };
```

### Tests

For each tool, add a test that verifies `result.metadata` has the expected shape and values on a successful call. Verify that error returns do NOT have metadata set.

Run: `bun test packages/server/test/` — all tests should pass.

Commit: `feat(server): add metadata to read_file, write_file, list_directory tools`

---

## Task 2: UI — UUID-based panel matching + quiet tool label override

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts` — add `id` to `MessagePart` types, pass through
- Modify: `packages/ui/src/App.tsx` — refactor Panel type, groupParts, quietTools, rendering

### useWebSocket.ts changes

Add `id: string` to both tool_call and tool_result variants of `MessagePart`:

```ts
export type MessagePart =
    | { type: "text"; content: string }
    | { type: "tool_call"; id: string; name: string; content: string; oldString?: string; newString?: string }
    | { type: "tool_result"; id: string; name: string; content: string; isError: boolean; metadata?: Record<string, unknown> };
```

Pass `msg.id` through in both the tool_call and tool_result handlers (lines ~70 and ~99).

### App.tsx changes

**1. Add grep_search to quietTools:**

```ts
const quietTools = new Set(["read_file", "write_file", "list_directory", "grep_search"]);
```

**2. Change Panel.calls from `string[]` to `{ id: string; label: string }[]`:**

```ts
type ToolCall = { id: string; label: string };

type Panel =
    | { type: "text"; content: string }
    | {
        type: "tool";
        name: string;
        calls: ToolCall[];
        result?: string;
        isError?: boolean;
        quiet?: boolean;
        diff?: { oldString: string; newString: string };
    };
```

**3. Add `formatQuietSuffix` helper:**

```ts
function formatQuietSuffix(name: string, metadata?: Record<string, unknown>): string {
    if (!metadata) return "";
    if (name === "read_file") {
        const n = metadata.linesRead as number;
        return `(${n} ${n === 1 ? "line" : "lines"})`;
    }
    if (name === "write_file") {
        const n = metadata.bytesWritten as number;
        return `(${n} bytes)`;
    }
    if (name === "list_directory") {
        const n = metadata.entryCount as number;
        return `(${n} ${n === 1 ? "entry" : "entries"})`;
    }
    if (name === "grep_search") {
        const n = metadata.matchCount as number;
        if (n === 0) return "(no results)";
        return `(${n} ${n === 1 ? "result" : "results"})`;
    }
    return "";
}
```

**4. Refactor `groupParts` to use ID-based matching:**

```ts
function groupParts(parts: MessagePart[]): Panel[] {
    const panels: Panel[] = [];
    const callIndex = new Map<string, { panel: Panel & { type: "tool" }; callIdx: number }>();

    for (const part of parts) {
        if (part.type === "text") {
            panels.push({ type: "text", content: part.content });
        } else if (part.type === "tool_call") {
            const isQuiet = quietTools.has(part.name);
            const last = panels.at(-1);
            const call: ToolCall = { id: part.id, label: part.content };

            if (last?.type === "tool" && last.quiet && isQuiet) {
                // Merge into existing quiet panel
                last.calls.push(call);
                callIndex.set(part.id, { panel: last, callIdx: last.calls.length - 1 });
            } else {
                const diff =
                    part.oldString != null && part.newString != null
                        ? { oldString: part.oldString, newString: part.newString }
                        : undefined;
                const panel = { type: "tool" as const, name: part.name, calls: [call], diff, quiet: isQuiet };
                panels.push(panel);
                callIndex.set(part.id, { panel, callIdx: 0 });
            }
        } else if (part.type === "tool_result") {
            const entry = callIndex.get(part.id);
            if (!entry) continue;

            if (entry.panel.quiet) {
                // Quiet tool: update the call label with result info
                if (part.isError) {
                    entry.panel.calls[entry.callIdx].label += " (error)";
                } else {
                    const suffix = formatQuietSuffix(part.name, part.metadata);
                    if (suffix) {
                        entry.panel.calls[entry.callIdx].label += ` ${suffix}`;
                    }
                }
            } else if (part.name === "edit_file") {
                // edit_file: suppress text result (diff shown instead)
            } else {
                // Non-quiet: show result as block
                entry.panel.result = part.content;
                entry.panel.isError = part.isError;
            }
        }
    }
    return panels;
}
```

**5. Update rendering — panel.calls is now `ToolCall[]`:**

Change the JSX that maps `panel.calls` from:
```tsx
{panel.calls.map((call) => (
    <div key={call} className="tool-call">{call}</div>
))}
```
To:
```tsx
{panel.calls.map((call) => (
    <div key={call.id} className="tool-call">{call.label}</div>
))}
```

Run: `bunx biome check src/` from `packages/ui/` — should be clean.

Commit: `feat(ui): UUID-based panel matching and quiet tool label override`
