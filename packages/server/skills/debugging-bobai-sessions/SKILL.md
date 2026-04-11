---
name: debugging-bobai-sessions
mode: debug
description: >-
  Debug Bob AI application issues using session database and log files.
  Provides DB schema, log format, file locations, and query recipes.
  Triggers on "debug session", "inspect session", "check logs",
  "what happened in session", "session issue", "debug bobai",
  "log file", "bobai database", "bobai.db", "session history",
  "message history", "tool call history", "subagent session".
  PROACTIVE: Use when investigating any Bob AI runtime behavior,
  session anomaly, or application error.
---

# Debugging Bob AI Sessions

## Key Locations

| Resource | Path |
|----------|------|
| Session database | `<project>/.bobai/bobai.db` |
| Log files | `~/.local/share/bobai/log/YYYY-MM-DD.log` |
| HTTP dump files | `~/.local/share/bobai/log/debug-*-http.txt` (debug mode only) |
| Compaction dump files | `~/.local/share/bobai/log/debug-*-pre*.txt` / `debug-*-emg*.txt` (debug mode only) |

## ⚠ Timezone Warning

**Log timestamps are local time. Database timestamps are UTC.**

- **DB:** `2026-04-02T15:00:59.077Z` — UTC ISO 8601 (always ends with `Z`)
- **Log:** `2026-04-02 17:00:59.077` — local timezone (no `Z`, no `T`)

When correlating log entries with DB records, convert between timezones. In the DB, use SQLite's `datetime()` with a timezone offset to align with log times, or mentally apply the offset.

## Database

Use the built-in **sqlite3 tool** for all database queries — no need for bash or external tools.

### Schema

**`sessions` table:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUIDv4 |
| `title` | TEXT | Nullable; set by user or auto-generated |
| `model` | TEXT | Nullable; e.g. `"claude-opus-4.6"` |
| `parent_id` | TEXT FK → sessions(id) | Nullable; non-null means subagent session |
| `prompt_tokens` | INTEGER | Last known prompt token count |
| `prompt_chars` | INTEGER | Last known prompt character count |
| `created_at` | TEXT | UTC ISO 8601 |
| `updated_at` | TEXT | UTC ISO 8601; updated on every change |

**`messages` table:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUIDv4 |
| `session_id` | TEXT FK → sessions(id) | |
| `role` | TEXT | `system`, `user`, `assistant`, `tool` |
| `content` | TEXT | Message text; may be empty for tool-call messages |
| `created_at` | TEXT | UTC ISO 8601 |
| `sort_order` | INTEGER | 0-based, auto-incremented per session |
| `metadata` | TEXT | Nullable; JSON blob (see below) |

**Index:** `idx_messages_session` on `(session_id, sort_order)`.

**PRAGMAs:** WAL journal mode, foreign keys enabled.

### Metadata JSON

The `metadata` column stores different structures depending on role.

**Assistant tool-call message** (`role = "assistant"`, `content` often empty):
```json
{
  "tool_calls": [
    {
      "id": "call-uuid",
      "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"src/foo.ts\"}" }
    }
  ]
}
```

**Assistant final response** (`role = "assistant"`, end of turn):
```json
{
  "summary": "gpt-5 | agent: 3 | ...",
  "turn_model": "gpt-5"
}
```

**Tool result** (`role = "tool"`):
```json
{
  "tool_call_id": "call-uuid",
  "format_call": "▸ read_file src/foo.ts",
  "ui_output": "rendered output for UI",
  "mergeable": true,
  "tool_summary": "short summary"
}
```

**User message** — `metadata` is usually null. Subagent-originated user messages have `{"source": "agent"}`.

### Session Relationships

- One session has many messages, ordered by `sort_order`.
- Root sessions have `parent_id IS NULL`.
- Subagent sessions have `parent_id` pointing to the parent session.

## Useful Queries

List recent sessions:
```sql
SELECT id, title, model, prompt_tokens,
       created_at, updated_at
FROM sessions
WHERE parent_id IS NULL
ORDER BY updated_at DESC
LIMIT 10;
```

List subagent sessions for a parent:
```sql
SELECT id, title, model, created_at
FROM sessions
WHERE parent_id = '<session-id>'
ORDER BY created_at;
```

Browse messages in a session:
```sql
SELECT sort_order, role, substr(content, 1, 120) AS preview,
       json_extract(metadata, '$.tool_calls[0].function.name') AS tool_name
FROM messages
WHERE session_id = '<session-id>'
ORDER BY sort_order;
```

Find all tool calls in a session:
```sql
SELECT sort_order,
       json_extract(metadata, '$.tool_calls[0].function.name') AS tool,
       substr(json_extract(metadata, '$.tool_calls[0].function.arguments'), 1, 100) AS args
FROM messages
WHERE session_id = '<session-id>'
  AND json_extract(metadata, '$.tool_calls') IS NOT NULL
ORDER BY sort_order;
```

Find tool results for a specific call:
```sql
SELECT sort_order, substr(content, 1, 200) AS result,
       json_extract(metadata, '$.format_call') AS call_display
FROM messages
WHERE session_id = '<session-id>'
  AND json_extract(metadata, '$.tool_call_id') = '<call-id>'
ORDER BY sort_order;
```

Count messages per role in a session:
```sql
SELECT role, count(*) AS cnt
FROM messages
WHERE session_id = '<session-id>'
GROUP BY role;
```

Find sessions by title keyword:
```sql
SELECT id, title, model, updated_at
FROM sessions
WHERE title LIKE '%keyword%'
ORDER BY updated_at DESC;
```

## Log Files

### Line Format

```
TIMESTAMP LEVEL SYSTEM SCOPE MESSAGE
```

Example lines:
```
2026-04-02 15:15:26.090 INFO SERVER global Starting bobai (debug=true)
2026-04-02 15:15:34.829 DEBUG COMPACTION 32b87f44 debug-20260403...
2026-04-02 16:12:30.997 DEBUG AUTH 514cc003-3b5d45ba Session valid (expires in 684s)
```

### Fields

| Field | Description |
|-------|-------------|
| **Timestamp** | `YYYY-MM-DD HH:MM:SS.mmm` — **local timezone** |
| **Level** | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| **System** | Subsystem: `SERVER`, `AUTH`, `HTTP`, `COMPACTION`, `SKILL`, `PLUGIN`, `RETRY`, `CONFIG`, `REPAIR` |
| **Scope** | `global` (not session related), `1d73fc5a` (session, first 8 chars of UUID), `514cc003-3b5d45ba` (parent-child subagent, first 8 chars of each UUID) |
| **Message** | Free-form text |

### Searching Logs

Filter by session — use the first 8 characters of the session UUID:
```bash
grep '1d73fc5a' ~/.local/share/bobai/log/2026-04-02.log
```

Filter by subagent (parent-child):
```bash
grep '514cc003-3b5d45ba' ~/.local/share/bobai/log/2026-04-02.log
```

Find errors:
```bash
grep 'ERROR' ~/.local/share/bobai/log/2026-04-02.log
```

Find compaction events:
```bash
grep 'COMPACTION' ~/.local/share/bobai/log/2026-04-02.log
```

### Debug Mode Files

Enable with `--debug` flag or `"debug": true` in config.

**HTTP dumps** (`debug-YYYYMMDD-HHMMSSmmm-SCOPE-http.txt`):
```
>>> POST https://api.business.githubcopilot.com/v1/messages
(headers)

(request body)

<<< 200 OK (2654ms)
(headers)

(response body)
```
Authorization headers are masked in dump files.

**Compaction dumps** (`debug-YYYYMMDD-HHMMSSmmm-SCOPE-SUFFIX.txt`):
- Suffix: `preN` or `emgN`
- `N=0`: before compaction, `N=1`: after compaction, `N=2`: after eviction (only when eviction changed something)

## Debugging Workflow

1. **Identify the session** — find it by title, time, or model in the `sessions` table.
2. **Extract the session tag** — first 8 characters of the session UUID (before the first `-`).
3. **Determine the log date** — convert the session's UTC `created_at` to local time to find the right `YYYY-MM-DD.log` file.
4. **Correlate DB and logs** — remember the timezone offset when matching timestamps.
5. **Inspect messages** — query the `messages` table ordered by `sort_order` to see the full conversation flow.
6. **Check tool calls** — extract tool names and arguments from `metadata` JSON.
7. **Read compaction dumps** — if context pressure is involved, find the `debug-*pre*` and `debug-*emg*` files referenced in log lines.
