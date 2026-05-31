# Bob AI Glossary

Canonical vocabulary for Bob AI concepts. Use these terms consistently in
conversations, issues, and commits. When an internal name differs from casual
speech, the internal name wins.

---

## UI Anatomy

The UI is a single-page app with a **three-zone flex layout** (top to bottom).
No modals, drawers, sidebars, or routing. Navigation swaps content in place.

### Status Bar (top zone)

Fixed bar at the top. Contains, from left to right:

| Element | Description |
|---------|-------------|
| **Status dot** | Green/red connection indicator. Pulses when the agent is active. |
| **Status bar label** | "Bob AI" text. |
| **Status bar title** | Project dir, git branch, session title. Shows a breadcrumb trail when viewing a subagent. |
| **Status** (right) | Current provider, model, and pricing or multiplier info. |

### Messages (middle zone)

Scrollable area that fills available space. Content depends on the active
**view mode**:

| View Mode | Description |
|-----------|-------------|
| **Chat** (default) | Grouped panels with rendered Markdown. |
| **Context** | Raw stored messages as plain text — what is in the database. |
| **Compaction** | What the LLM actually sees after compaction and eviction. |

View modes are cycled with the `.view` dot command.

#### Panels

Messages are rendered as **panels** — the primary visual unit inside the
messages zone.

| Panel | Description |
|-------|-------------|
| **User panel** | The human prompt text. |
| **Assistant panel** | The LLM's prose or Markdown response. |
| **Tool panel** | A tool call and its result. Collapsible by default at 6+ lines. Double-clickable to navigate into subagents. |
| **Volatile panel** | Ephemeral notification above the prompt. Kinds: `error`, `success`. |

A **panel status line** appears at the bottom of each panel. It shows
timestamp, model, and turn summary.

When the session has no messages yet, the UI shows a **welcome screen** fetched
from the server.

### Prompt Panel (bottom zone)

The text input area. Between the messages zone and the prompt input, several
transient panels can appear:

| Element | Description |
|---------|-------------|
| **Dot panel** | Autocomplete and picker for dot commands. Appears when input starts with `.` |
| **Slash panel** | Skill picker. Appears when input starts with `/` |
| **Staged skills** | Shows skills queued for injection before the next prompt |
| **Prompt input** | The textarea. Grayed out and read-only when browsing history |

### Read-Only States

The prompt input becomes read-only when:

- viewing a subagent session
- the session is locked by another tab
- a non-chat view mode is active

---

## Core Concepts

### Session

A conversation thread. Owns an ordered list of messages. Two flavors:

- **Parent session** — top-level, listed in the session picker
- **Subagent session** — child of a parent, created by the `task` tool

Sessions have **ownership** — one browser tab owns a session at a time. Other
tabs see it as **locked**.

### Message

A single entry in a session's conversation. Has a **role**:

| Role | Description |
|------|-------------|
| **system** | System prompt. Built dynamically each turn, not persisted. |
| **user** | Human prompt, or a synthetic prompt injected by the `task` tool and marked with `source: "agent"` in metadata. |
| **assistant** | LLM response. May contain tool calls in metadata. |
| **tool** | Tool execution result. Linked to its tool call via `tool_call_id`. |

Messages carry a **metadata** JSON blob for structured data such as tool calls,
model info, subagent references, and compaction markers.

### Turn

An implicit concept, not a stored entity. A turn starts at a user message and
extends through all assistant responses and tool calls until the next user
message. The UI merges all messages within a turn into a single visual group.
Turn metrics such as token usage, timing, and cost are tracked by the provider
and shown in panel status lines.

### Subagent

A child session spawned by the `task` tool to handle a complex subtask.

Characteristics:

- runs its own agent loop with independent history
- cannot spawn nested subagents because the `task` tool is removed from its tool set
- can be resumed by passing `task_id` to the `task` tool
- is tracked via `SubagentStatus`: `running`, `done`, or `error`
- multiple subagents from one assistant response run **in parallel**
- can be **peeked** from the parent session, live or from the database

Subagents are indexed 1-based in creation order within a parent session.
The `.subagent` command uses that index.

### Tool

A capability exposed to the LLM, such as `read_file`, `bash`, or `task`.
Each tool has:

- a **definition** sent to the LLM
- an **execute** function that returns separate `llmOutput` and `uiOutput`
- optional compaction logic
- a **mergeable** flag for UI grouping

Built-in tools: `read_file`, `list_directory`, `file_search`, `write_file`,
`edit_file`, `grep_search`, `bash`, `sqlite3`, `web_fetch`, `task`, `skill`.

### Skill

A loadable instruction set stored as Markdown with YAML frontmatter.
Skills can be:

- **loaded by the LLM** via the `skill` tool during a turn
- **staged by the user** via `/skillname` before sending a prompt

Skills are discovered from `SKILL.md` files in configured directories.

### Provider

An LLM backend.

Current runtime providers:

- **GitHub Copilot**
- **OpenRouter**
- **OpenCode Go**
- **OpenCode Zen**

Each provider maps models to one of the current API families:

- `anthropic-messages`
- `openai-responses`
- `openai-chat-completions`

Providers handle streaming, token counting, turn metrics, summaries, and auth.

An **isolated turn provider** wraps a provider for parallel subagent execution
with independent metrics.

### Model

An LLM model available through a provider. Each model has:

- an ID
- a display name
- a context window
- a max output token limit
- input and output pricing per 1M tokens
- for Copilot, an optional **premium request multiplier**

Bob AI stores all provider model metadata in a single generated file:

- `~/.config/bobai/models.json`

This file is grouped by provider and is the source of truth for runtime model
selection and display.

Important rules:

- there is **no curated model list** anymore
- Bob AI includes only supported providers
- Bob AI includes only models with tool support and complete metadata
- Copilot token prices are stored as `0`
- Copilot models may have a missing multiplier, in which case the UI shows `?x`
- default models are still hardcoded per provider in the registry

### Model Catalog

The **model catalog** is the generated `models.json` file in the global config
directory.

It is refreshed from:

- `models.dev` for model metadata
- GitHub Copilot billing docs for Copilot multipliers

Startup behavior:

- if the catalog is missing, Bob AI refreshes it synchronously before the server starts
- if refresh fails and no catalog exists, startup fails
- if refresh fails but a stale catalog exists, Bob AI logs the failure and keeps using the stale file

### Compaction

A context management system that reduces message size as context grows.
Two mechanisms:

- **Compaction** — reduces content size of individual tool outputs and arguments
- **Eviction** — removes intermediate messages from old turns entirely

Compacted content is prefixed with `# COMPACTED`.

### Instructions

Layered instruction files injected into the system prompt:

| Layer | Source | Description |
|-------|--------|-------------|
| **Global** | `~/.config/bobai/AGENT.md` | User-wide preferences and rules |
| **Project (bobai)** | `<project>/.bobai/AGENT.md` | Project-specific Bob AI instructions |
| **Project (standard)** | `AGENT.md`, `AGENTS.md`, `CLAUDE.md` in project root | Standard AI agent instruction files |

### Project

A working directory with Bob AI initialized. Project state lives in `.bobai/`:

- config (`bobai.json`)
- database (`bobai.db`)
- project-level instructions
- compacted tool outputs (`compaction/`)
- downloaded web content (`downloads/`)

---

## Dot Commands

Commands prefixed with `.` that control the application. They are never sent to
the LLM.

### Command List

| Command | Syntax | Description |
|---------|--------|-------------|
| `.configuration` | `.configuration [project\|global] [field] [value]` | Read or write project or global configuration |
| `.model` | `.model <N>` | Switch the current session model |
| `.new` | `.new [title]` | Start a new session |
| `.provider` | `.provider <N>` | Switch the current session provider |
| `.session` | `.session [N\|text] [delete]` | Switch to session `N`, search by title, or delete with `N delete` |
| `.stop` | `.stop` | Cancel the running agent loop |
| `.subagent` | `.subagent [N]` | Peek at subagent `N` |
| `.title` | `.title <text>` | Rename the current session |
| `.view` | `.view [1\|2\|3]` | Switch view mode: 1=Chat, 2=Context, 3=Compaction |

### Abbreviation System

Any **unambiguous prefix** resolves to that command.
There is no hardcoded alias table.

Trailing digits are split off as arguments automatically.

| Shortcut | Resolves To | Why |
|----------|-------------|-----|
| `.c` | `.configuration` | only command starting with `c` |
| `.m` | `.model` | only command starting with `m` |
| `.m3` | `.model 3` | `m` resolves to model, `3` becomes the argument |
| `.p` | `.provider` | only command starting with `p` |
| `.n` | `.new` | only command starting with `n` |
| `.t` | `.title` | only command starting with `t` |
| `.v` | `.view` | only command starting with `v` |
| `.su` | `.subagent` | disambiguates from `session` and `stop` |
| `.se` | `.session` | disambiguates from `stop` and `subagent` |
| `.st` | `.stop` | disambiguates from `session` and `subagent` |
| `.s` | *(ambiguous)* | shows the selection panel |

### Command Availability

Available commands change based on session state:

| State | Available Commands |
|-------|-------------------|
| **Normal** | `configuration`, `limit`, `model`, `new`, `provider`, `session`, `subagent`, `title`, `view` |
| **Streaming** | `configuration`, `stop`, `subagent` |
| **Read-only** | `configuration`, `new`, `session`, `subagent`, `title`, `view` |
| **Locked** | `configuration`, `new`, `session` |

### Configuration Command Architecture

The `.configuration` command uses a **three-level tree**: scope → field → value.
Each level narrows by prefix match until the user reaches a leaf.

| Level | Nodes | Kind |
|-------|-------|------|
| **Scope** | `project`, `global` | menu |
| **Field** | `debug`, `provider`, `model`, `port`, `maxIterations` | menu (debug, provider, model) or text (port, maxIterations) |
| **Value** | dynamic — depends on field | action (debug: true/false), menu (provider/model: pickable list), text (port, maxIterations: free input) |

Provider and model fields use the same **dynamic pickers** as the standalone
`.provider` and `.model` commands — fuzzy-filtered lists with cost and context
window display. The model list is tied to the **configured** provider (from
project or global config), not the current session's provider.

#### Enter Key Commit Path

When Enter is pressed, the tree-resolved commit path is built from the current
state — not from the raw abbreviated input. Numeric filters are resolved by
exact index match against visible children; text filters pick the first
fuzzy-sorted child (consistent with `.session` and `.model`).

The resolved path is passed to `submit()` via a ref (`commitPathRef`) populated
by `DotCommandPanel` on every render.

#### Server-Side

- **Display**: `bare .c`, `.c <scope>`, and `.c <scope> <field>` read from the
  in-memory config cache. The cache is kept in sync with disk after every write.
- **Write**: `.c <scope> <field> <value>` validates the value (provider and
  model exist in the catalog, port and maxIterations are in range, etc.) and
  persists to `bobai.json`.
- **Default backend resolution**: at server startup, the project and global
  config layers are validated. If a configured model doesn't exist in that
  provider's catalog, the provider's hardcoded default model is used as a
  fallback instead of rejecting the entire layer.

---

## Provider and Pricing Display

In the status bar and model picker:

- **Copilot** displays a multiplier such as `0x`, `1x`, or `?x`
- **other providers** display token prices such as `$0.50 | $5.12`

In turn summaries:

- OpenRouter may display `free` for truly zero-cost models
- other providers usually show token counts and context deltas without a separate cost label unless the provider summary logic adds one
