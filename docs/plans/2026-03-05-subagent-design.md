# Subagent Design

## Purpose

Subagents let the primary agent delegate work to independent child sessions. Each child session runs its own agent loop with full tool access (except spawning further subagents), streams progress to the UI, and returns its final text to the parent as a tool result.

## Design Decisions

- **Single agent type.** Subagents use the same system prompt and model as the parent session. No agent registry, no mode field, no prompt variants.
- **Minimal permission control.** Subagents receive all tools except `task`. The tool description instructs the LLM to avoid `edit_file` and `write_file` for exploratory tasks. No formal permission system.
- **Title generation.** Each subagent gets a short title via a quick `gpt-5-mini` call. Falls back to the `description` parameter if the call fails.
- **Initiator.** All subagent LLM calls use `initiator: "agent"`, not `"user"`.
- **Abort propagation.** The parent's `AbortSignal` propagates to child sessions. The mechanism to trigger abort from the parent is deferred.
- **No parallel tool execution.** Tool calls within a single LLM response still execute sequentially. Multiple `task` tool calls in one response run one at a time. Parallel execution is a separate enhancement.

## Data Model

### Schema Change

Add a nullable `parent_id` column to the `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id);
```

Regular sessions have `parent_id = NULL`. Subagent sessions point to their parent.

### Subagent Status

Track running subagents in memory with a `Map<sessionId, "running" | "done">`. After server restart, all subagents default to "done". No new DB column needed.

### New Repository Functions

- `createSubagentSession(db, parentId, title, model)` — creates a session with `parent_id` set.
- `listSubagentSessions(db, limit?)` — returns recent subagent sessions ordered by `updated_at DESC`. Default limit: 5.

## The `task` Tool

Registered alongside the existing six tools. The parent agent calls it to spawn a subagent.

### Parameters

| Parameter     | Type   | Required | Description                                      |
|---------------|--------|----------|--------------------------------------------------|
| `description` | string | yes      | Task description, up to 20 words                 |
| `prompt`      | string | yes      | Full instructions for the subagent               |
| `task_id`     | string | no       | Resume a previous subagent session               |

### Execution Flow

1. **Generate title** — call `gpt-5-mini` with the prompt to produce a short title. On failure, use `description`.
2. **Create child session** — `createSubagentSession(db, parentId, title, model)`. Model inherited from parent.
3. **Build tool registry** — same tools as parent, minus `task`.
4. **Run agent loop** — call `runAgentLoop()` with:
   - The child session's messages (system prompt + task prompt as a user-role message with `{ source: "agent", parentSessionId }` metadata).
   - `initiator: "agent"`.
   - An `onEvent` callback that tags events with the child's `sessionId` before sending over the parent's WebSocket.
   - An `onMessage` callback that persists messages to the child session.
   - The parent's `AbortSignal` for cancellation propagation.
5. **Return result** — extract the final assistant text from the child's output. Return it as the tool result, including `task_id` (the child sessionId) for potential resumption.

### Resumption

When `task_id` is provided, skip title generation and session creation. Load the existing child session and continue from where it left off.

### Tool Description (for the LLM)

The tool description tells the LLM:
- Launch subagents for complex, multi-step tasks that can run independently.
- For exploratory/read-only tasks, instruct the subagent to avoid `edit_file` and `write_file`.
- Include `task_id` in the response to allow the parent to resume the subagent later.
- Each subagent starts with a fresh conversation containing only the prompt.

## WebSocket Protocol

### Changes to `ServerMessage`

Every existing variant (`token`, `tool_call`, `tool_result`, `status`, `done`, `error`) gains an optional field:

```typescript
sessionId?: string
```

When absent, events belong to the parent session. When present, the UI routes them to the corresponding subagent panel.

### New Message Types

```typescript
{ type: "subagent_start"; sessionId: string; title: string }
{ type: "subagent_done"; sessionId: string }
```

- `subagent_start` — sent when the child session is created, before the agent loop begins.
- `subagent_done` — sent when the child's agent loop completes.

### Event Flow

1. Parent streams normally (no `sessionId` on events).
2. Parent LLM emits a `task` tool call — UI sees `tool_call` event on the parent panel.
3. Server sends `subagent_start` — UI opens a minimal subagent panel showing the title.
4. Child agent loop runs — events tagged with child `sessionId` flow to the UI but the subagent panel only displays the title and a "running" indicator (no streaming text or tool details).
5. Child finishes — server sends `subagent_done` — UI updates the panel with the turn summary (same format as a regular completed turn: timestamp, model, token counts, duration).
6. Parent receives the tool result and continues.

## `.subagent` Dot Command

### Registration

Added to `handleCommand` in `command.ts`.

### Behavior

**No arguments.** Lists the 5 most recently updated subagent sessions (across all parents), ordered by `updated_at DESC`:

```
1: Exploring codebase structure
2: Implementing auth validation
3: Reading project configuration files
```

**With numeric argument (deferred).** Selects a subagent session of the current parent and switches to it. This depends on the `.session` command infrastructure. `.session` switches between parent sessions; `.subagent` switches between child sessions of the current parent.

### Server Endpoint

`GET /bobai/subagents` — returns recent subagent sessions. Response:

```json
[
  { "index": 1, "title": "Exploring codebase structure", "sessionId": "abc-123" },
  { "index": 2, "title": "Implementing auth validation", "sessionId": "def-456" }
]
```

## UI

### Subagent Panel

A minimal panel in the parent session's view:

- **On `subagent_start`:** Panel appears with the title and a "running" indicator.
- **On `subagent_done`:** Panel updates with the turn summary line (same method/format as a completed regular turn).

No streaming text, tool calls, or tool results displayed in the subagent panel. Full conversation detail will be viewable via `.subagent` session switching (deferred).

### `.subagent` Command UI

Same pattern as `.model` — a numbered list panel that appears when the user types `.subagent`.
