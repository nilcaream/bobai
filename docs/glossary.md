# Bob AI Glossary

Canonical vocabulary for Bob AI concepts. Use these terms consistently in
conversations, issues, and commits. When an internal name differs from casual
speech, the internal name wins.

---

## UI Anatomy

The UI is a single-page app with a **three-zone flex layout** (top to bottom).
No modals, drawers, sidebars, or routing — navigation swaps content in place.

### Status Bar (top zone)

Fixed bar at the top. Contains (left to right):

| Element | Description |
|---------|-------------|
| **Status dot** | Green/red connection indicator. Pulses when the agent is active. |
| **Status bar label** | "Bob AI" text. |
| **Status bar title** | Project dir, git branch, session title. Shows a breadcrumb trail when viewing a subagent. |
| **Status** (right) | Current model name and cost info. |

### Messages (middle zone)

Scrollable area that fills available space. Content depends on the active
**view mode**:

| View Mode | Description |
|-----------|-------------|
| **Chat** (default) | Grouped panels with rendered Markdown. |
| **Context** | Raw stored messages as plain text — what's in the database. |
| **Compaction** | What the LLM actually sees after compaction/eviction is applied. |

View modes are cycled with the `.view` dot command.

#### Panels

Messages are rendered as **panels** — the primary visual unit inside the
messages zone.

| Panel | Description |
|-------|-------------|
| **User panel** | The human's prompt text. |
| **Assistant panel** | The LLM's prose/Markdown response. |
| **Tool panel** | A tool call and its result. Collapsible (collapsed by default at 6+ lines). Double-clickable to navigate into subagents. |
| **Volatile panel** | Ephemeral notification above the prompt. Kinds: `error`, `success`. |

A **panel status line** appears at the bottom of each panel showing timestamp,
model, and turn summary.

When the session has no messages yet, a **welcome screen** is shown (fetched
from the server).

### Prompt Panel (bottom zone)

The text input area. Between the messages zone and the prompt input, several
transient panels can appear:

| Element | Description |
|---------|-------------|
| **Dot panel** | Autocomplete/picker for dot commands. Appears when input starts with `.` |
| **Slash panel** | Skill picker. Appears when input starts with `/`. |
| **Staged skills** | Shows skills queued for injection before the next prompt. |
| **Prompt input** | The textarea. Grayed out and read-only when browsing history. |

### Read-Only States

The prompt input becomes read-only when:
- Viewing (peeking at) a subagent session
- The session is locked (owned by another tab)
- A non-chat view mode is active

---

## Core Concepts

### Session

A conversation thread. Owns an ordered list of messages. Two flavors:

- **Parent session** — top-level, listed in the session picker.
- **Subagent session** — child of a parent, created by the `task` tool. Not
  listed in the session picker. Linked to parent via `parentId`.

Sessions have **ownership** — one browser tab owns a session at a time. Other
tabs see it as **locked** (only `.new` and `.session` commands work).

### Message

A single entry in a session's conversation. Has a **role**:

| Role | Description |
|------|-------------|
| **system** | System prompt. Built dynamically each turn, not persisted. |
| **user** | Human prompt, or a synthetic prompt injected by the `task` tool (marked with `source: "agent"` in metadata). |
| **assistant** | LLM response. May contain tool calls in its metadata. |
| **tool** | Tool execution result. Linked to its tool call via `tool_call_id`. |

Messages carry a **metadata** JSON blob for structured data (tool calls, model
info, subagent references, compaction markers, etc.).

### Turn

An implicit concept — not a stored entity. A turn starts at a user message and
extends through all assistant responses and tool calls until the next user
message. The UI merges all messages within a turn into a single visual group.
Turn metrics (call counts, token usage, cost, timing) are tracked by the
provider and displayed in panel status lines.

### Subagent

A child session spawned by the `task` tool to handle a complex subtask. Key
characteristics:

- Runs its own agent loop with independent message history.
- Cannot spawn nested subagents (the `task` tool is excluded from its tool set).
- Can be **resumed** by passing a `task_id` to the `task` tool.
- Tracked via `SubagentStatus`: `running`, `done`, or `error`.
- Multiple subagents from one assistant response run **in parallel**.
- The UI can **peek** into a subagent's messages without leaving the parent
  session — live for running subagents, from the database for completed ones.

Subagents are indexed 1-based in the order they were created within a parent
session. The `.subagent` command uses this index.

### Tool

A capability exposed to the LLM (e.g., `read_file`, `bash`, `task`). Each
tool has:

- A **definition** (name, description, parameter schema) sent to the LLM.
- An **execute** function that returns a **tool result** with separate
  `llmOutput` (what the LLM sees) and `uiOutput` (what the user sees).
- Optional **compact** functions for reducing output size under context pressure.
- A **mergeable** flag — when true, the UI can visually merge adjacent results.

Built-in tools: `read_file`, `list_directory`, `file_search`, `write_file`,
`edit_file`, `grep_search`, `bash`, `sqlite3`, `web_fetch`, `task`, `skill`.

### Skill

A loadable instruction set (Markdown with YAML frontmatter) that provides
specialized workflows. Skills can be:

- **Loaded by the LLM** via the `skill` tool during a turn.
- **Staged by the user** via `/skillname` slash command before sending a prompt
  — injected as synthetic tool-call message pairs.

Skills are discovered from `SKILL.md` files in configured directories.

### Provider

The LLM backend. Currently only **GitHub Copilot** is supported, which routes
to either OpenAI or Anthropic APIs depending on the model. The provider handles
streaming, token counting, turn metrics, and auth token management.

An **isolated turn provider** wraps the main provider for parallel subagent
execution with independent metrics.

### Model

An LLM model available through the provider. Each model has an ID (e.g.,
`claude-sonnet-4.6`), context window size, max output tokens, and a **premium
request multiplier** (cost factor). Models are probed at startup — only
reachable models are enabled.

### Compaction

A context management system that reduces message size as context grows. Two
mechanisms:

- **Compaction** — reduces content size of individual tool outputs/arguments
  based on a **compaction factor** (product of context pressure × message age).
  Compacted content is prefixed with `# COMPACTED`.
- **Eviction** — removes intermediate messages from old turns entirely, keeping
  only the user prompt, task tool-call pairs, and the final assistant response.

### Instructions

Layered instruction files injected into the system prompt:

| Layer | Source | Description |
|-------|--------|-------------|
| **Global** | `~/.config/bobai/AGENT.md` | User-wide preferences and rules. |
| **Project (bobai)** | `<project>/.bobai/AGENT.md` | Project-specific bobai configuration. |
| **Project (standard)** | `AGENT.md`, `AGENTS.md`, `CLAUDE.md` in project root | Standard AI agent instruction files. |

### Project

A working directory with Bob AI initialized. Project state lives in the
`.bobai/` directory: config (`bobai.json`), database (`bobai.db`), and
project-level instructions.

---

## Dot Commands

Commands prefixed with `.` that control the application. Never sent to the LLM.

### Command List

| Command | Syntax | Description |
|---------|--------|-------------|
| `.model` | `.model <N>` | Switch LLM model. `N` is a 1-based index from the model list. |
| `.new` | `.new [title]` | Start a new session with an optional title. |
| `.session` | `.session [N\|text] [delete]` | Switch to session `N` (1-based index), search by title words, or delete with `N delete`. Without args: exit subagent peek / return to parent. |
| `.stop` | `.stop` | Cancel the running agent loop. |
| `.subagent` | `.subagent [N]` | Peek at subagent `N` (1-based index). Without args: show subagent list. |
| `.title` | `.title <text>` | Rename the current session. |
| `.view` | `.view [1\|2\|3]` | Switch view mode: 1=Chat, 2=Context, 3=Compaction. Without args: cycle. |

### Abbreviation System

Any **unambiguous prefix** of a command name resolves to that command. No
hardcoded alias table — it's pure prefix matching against available commands.

Additionally, **trailing digits** are split off as arguments automatically
(no command name contains a digit).

| Shortcut | Resolves To | Why |
|----------|-------------|-----|
| `.m` | `.model` | Only command starting with `m` |
| `.m3` | `.model 3` | `m` → model, `3` → argument |
| `.n` | `.new` | Only command starting with `n` |
| `.t` | `.title` | Only command starting with `t` |
| `.v` | `.view` | Only command starting with `v` |
| `.su` | `.subagent` | Disambiguates from `session` and `stop` |
| `.su1` | `.subagent 1` | `su` → subagent, `1` → argument |
| `.se` | `.session` | Disambiguates from `stop` and `subagent` |
| `.st` | `.stop` | Disambiguates from `session` and `subagent` |
| `.s` | *(ambiguous)* | Matches `session`, `stop`, `subagent` — shows selection panel |

### Command Availability

Available commands change based on session state:

| State | Available Commands |
|-------|-------------------|
| **Normal** | `model`, `new`, `session`, `subagent`, `title`, `view` |
| **Streaming** (agent running) | `stop`, `subagent` |
| **Read-only** (peeking, non-chat view) | `new`, `session`, `subagent`, `title`, `view` |
| **Locked** (another tab owns it) | `new`, `session` |

---

## WebSocket Protocol

The UI communicates with the server over a single WebSocket connection.

### Client → Server

| Message | Description |
|---------|-------------|
| **prompt** | Send a user message. Carries text, optional session ID, and staged skills. |
| **subscribe** | Claim ownership of a session. |
| **unsubscribe** | Release session ownership. |
| **cancel** | Abort the running agent loop. |

### Server → Client

| Message | Description |
|---------|-------------|
| **token** | Streaming text chunk from the LLM. |
| **tool_call** | Tool invocation started (name + formatted call). |
| **tool_result** | Tool execution completed (output). |
| **status** | Status bar update (model, tokens, cost). |
| **done** | Turn complete. |
| **error** | Error message. |
| **prompt_echo** | Echo of user prompt (used with staged skills). |
| **session_created** | New session established. |
| **subagent_start** / **subagent_done** | Subagent lifecycle events. |
| **session_subscribed** | Ownership confirmed. |
| **session_locked** | Session owned by another tab. |
