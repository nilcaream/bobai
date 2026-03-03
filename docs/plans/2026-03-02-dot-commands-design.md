# Dot Commands Design

## Purpose

Dot commands give users direct access to Bob AI session configuration without invoking the LLM. They are recognized when the first character in the prompt is a dot (`.`).

## Command Grammar

```
"." <command-prefix> [" " <arguments>]
```

- The prefix is everything between the dot and the first space.
- The arguments are everything after the first space, passed raw to the handler.
- Space advances to the command's submenu only when exactly one command matches the prefix.
- Commands match case-insensitively.
- Shift+Enter submits the command.
- Backspacing past the dot dismisses the panel and returns to normal prompt mode.

## Initial Commands

| Command   | Arguments    | Action                              |
|-----------|------------- |-------------------------------------|
| `model`   | index number | Switch the session's model          |
| `title`   | free text    | Set the session title               |
| `session` | TBD          | Switch sessions (deferred, phase 2) |

## Server-Side

### HTTP Endpoints

**`POST /bobai/command`** — Execute a dot command.

Request:
```json
{ "command": "model", "args": "1", "sessionId": "abc-123" }
```

Response:
```json
{ "ok": true }
```
```json
{ "ok": false, "error": "No session active" }
```

**`GET /bobai/models`** — Return enabled curated models in display order.

Response:
```json
{
  "models": [
    { "index": 1, "id": "gpt-5-mini", "label": "gpt-5-mini" },
    { "index": 2, "id": "claude-sonnet-4.6", "label": "sonnet-4.6" }
  ]
}
```

Labels are short display names (common prefixes like `claude-` stripped).

### Schema Change

Add a `model` column to the `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN model TEXT;
```

When `model` is `NULL`, the server falls back to the resolved default (`gpt-5-mini`). When set, the session model overrides the default.

### Prompt Handling Change

`handlePrompt` resolves the session before calling `runAgentLoop`. After resolution, it checks `session.model`. If set, that model is used; otherwise the config default applies.

### Command Handlers

Each handler is a thin function:

- **model**: Validate the index, look up the model ID from the curated list, update `sessions.model` for the given `sessionId`.
- **title**: Validate non-empty text, update `sessions.title` for the given `sessionId`.
- **session**: Return an error ("not implemented") until phase 2.

## Client-Side

### Panel State Machine

```
IDLE  →  COMMAND_SELECT  →  COMMAND_ARGS
  ↑          ↓                    ↓
  ←──────────←────────────────────←
         (backspace past dot)
```

**IDLE**: No dot prefix. Normal prompt mode. No panel.

**COMMAND_SELECT**: Input starts with `.`, no space yet (or space with ambiguous match). The panel shows command names filtered by the typed prefix.

**COMMAND_ARGS**: Exactly one command matched and the user typed a space. Panel content depends on the command:

- **model** — Fetch `GET /bobai/models` once on entry, cache in state. Show a numbered list filtered by the typed argument.
- **title** — Show hint text: "Set session title: `<typed text>`".
- **session** — Show "Not implemented".

### Panel UI

The panel renders as a `<div>` between the messages area and the prompt textarea. It uses the same CSS class as tool panels — 100% width, `1em` padding, `1em` margin, monospace, dark background. The only difference: it is volatile. It disappears after the command executes or the user backspaces past the dot.

### Submission Flow

On Shift+Enter while in dot command mode:

1. Parse the command name and arguments from the input.
2. `POST /bobai/command` with `{ command, args, sessionId }`.
3. On success: clear the textarea, dismiss the panel, update local state (model in status display, title in top bar).
4. On error: show the error message in the panel.

### Status Bar Change

The top bar gains the session title:

```
Bob AI ● session-title-here
```

The title appears after the connection indicator. When no title is set, nothing extra is shown. The title updates immediately when `.title` executes.

## Implementation Chunks

### Chunk 1 — Server-side foundation
- Add `model` column to `sessions` schema.
- Create `GET /bobai/models` endpoint.
- Create `POST /bobai/command` endpoint with `model` and `title` handlers.
- Update `handlePrompt` to read the session model before calling the agent loop.
- Tests for all of the above.

### Chunk 2 — Client-side dot command system
- Dot command parser (prefix extraction, state detection).
- Panel component (same CSS as tool panels, volatile).
- State machine: IDLE → COMMAND_SELECT → COMMAND_ARGS.
- Model list fetch and display.
- Title hint display.
- Shift+Enter submission via `POST /bobai/command`.
- Update local state on success.

### Chunk 3 — Status bar title display
- Show session title in top bar after the connection dot.
- Update title in real-time when `.title` executes.
- Return title in `done` WebSocket message so it persists across prompts.

### Deferred (Phase 2)
- `.session` command implementation (list and switch sessions).
- Drop global default model config in favor of session-only model.
