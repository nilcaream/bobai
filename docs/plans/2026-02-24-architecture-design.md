# Bob AI — Architecture Design

**Goal:** Define the high-level architecture for Bob AI, a browser-first coding agent built on radical context transparency.

---

## Overview

Bob AI is a coding agent that runs as a local server and presents its UI in the browser. The server handles all logic — LLM calls, tool execution, session state — while the browser acts as a thin rendering layer. Every session exposes full context composition so the user always knows what the model sees.

## System Architecture

```
Terminal                    Server (Bun)                  Browser (React)
───────                    ────────────                  ───────────────
$ bobai ──► HTTP server    ◄── WebSocket ──►            Thin client
             + WS server       bidirectional              - renders conversation
             + static serve                               - sends prompts
             + LLM calls                                  - displays context telemetry
             + tool execution                             - no secrets, no provider calls
             + session mgmt
```

### Startup Flow

1. User runs `bobai` in a project directory.
2. Server initializes `.bobai/` if absent (generates project UUID, creates SQLite DB).
3. Server picks an available port and starts listening.
4. Terminal prints `http://localhost:<port>/bobai`.
5. User opens the URL; browser loads the React app served by the same process.
6. WebSocket connection established; coding session begins.
7. Server runs until terminated (Ctrl+C or signal).

### Responsibility Split

| Browser (thin client)           | Server (all logic)                       |
|---------------------------------|------------------------------------------|
| Render conversation stream      | LLM provider calls, API key management   |
| Send user prompts via WebSocket | Tool execution (file ops, shell, search) |
| Display context telemetry       | Session management, SQLite persistence   |
| Local UI state only             | Configuration, auth, secrets             |
| No secrets, no provider calls   | Serve static React bundle                |

## Key Components

### CLI Entry (`bobai`)

- Single command, no subcommands for MVP.
- Reads configuration from `.bobai/config` and environment variables.
- Provider selection and API keys configured here (env vars, config file, or CLI flags).
- Prints the server URL and blocks until killed.

### Project State (`.bobai/`)

| Path                | Purpose                                                                                  |
|---------------------|------------------------------------------------------------------------------------------|
| `.bobai/bobai.json` | Auto-generated UUID, project metadata, user configuration (provider, model, preferences) |
| `.bobai/bobai.db`   | SQLite — message history, usage metrics, session logs                                    |
| `.bobai/plugins/`   | Local plugins (future)                                                                   |
| `.bobai/skills/`    | Local skills (future)                                                                    |

The `.bobai/` directory is gitignored by default.

### Server (Bun)

- **HTTP server:** Serves the React static bundle and handles REST endpoints if needed.
- **WebSocket server:** Primary transport for conversation streaming and context telemetry.
- **Provider layer:** Thin abstraction over LLM providers (see below).
- **Tool runtime:** Executes coding tools (file read/write/edit, shell, search) on behalf of the agent.
- **Session manager:** Tracks conversation state, persists to SQLite, computes token budgets.

### Frontend (React)

- Single-page app served from the Bun process.
- Connects to WebSocket on load.
- Renders streamed LLM responses, tool outputs, and context telemetry.
- Sends user prompts and actions upstream.
- Zero knowledge of providers, keys, or tool internals.

## LLM Provider Abstraction

A thin interface that normalizes streaming responses across providers. The server instantiates the configured provider at startup.

**MVP providers:**
- GitHub Copilot
- OpenCode Zen

**Approach (TBD):** Evaluate whether Vercel AI SDK covers both providers or whether a minimal hand-rolled abstraction is more practical. Decision deferred to implementation phase.

**No MCP support.**

## Context Transparency (Core Differentiator)

Every session surfaces what occupies the model's context window:

- **System prompt footprint** — token count and percentage of total budget.
- **Tool definitions** — how much space registered tools consume.
- **Conversation history** — token count per message, cumulative total.
- **Trimmed/evicted content** — what was removed and why.

The server computes all telemetry and pushes it to the browser over WebSocket. The browser renders it; it never computes token counts itself.

## Real-Time Context Garbage Collection (Future)

A planned second phase focused on intelligent context compaction:

- Streaming telemetry about context pressure (how close to the limit).
- Visibility into what stays, what gets evicted, and the eviction rationale.
- Goal: replace opaque compaction heuristics with an observable, tunable process.

Design details deferred until the transparency layer is stable.

## Future: Orchestrator (Deferred)

A standalone service that discovers running Bob AI instances (e.g., across Docker containers) and aggregates them behind a single browser endpoint with a session viewer. Quality-of-life improvement, not a core feature.

## Technology Summary

| Component      | Technology                                           |
|----------------|------------------------------------------------------|
| Server runtime | Bun                                                  |
| Language       | TypeScript                                           |
| Transport      | WebSocket (bidirectional)                            |
| Frontend       | React                                                |
| Storage        | SQLite (via `.bobai/bobai.db`)                       |
| LLM providers  | GitHub Copilot, OpenCode Zen (MVP)                   |
| MCP            | Not supported                                        |
| Naming         | `bobai` (directories, packages), `BobAI` (CamelCase) |

## Open Questions

- Vercel AI SDK vs. hand-rolled provider abstraction — needs compatibility research for Copilot and Zen.
- Exact tool set for MVP (file ops, shell, search — scope TBD).
- Context telemetry data model and WebSocket message protocol.
- React component library or styling approach for the browser UI.
