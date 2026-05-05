# Bob AI

A browser-first coding agent that runs as a local server and exposes a chat UI with coding tools, session history, subagents, and full context transparency.

Bob AI supports multiple providers:

- GitHub Copilot
- OpenRouter
- OpenCode Go
- OpenCode Zen

Its defining feature is **radical context transparency**. You can inspect the system prompt, tool calls, tool results, token usage, and the exact messages that remain after compaction.

## Installation

**Requirements:** Linux x86_64, `git`, `curl`, `unzip`.

The installer downloads its own Bun runtime. You do not need a global Node.js or Bun installation.

**One-liner (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/nilcaream/bobai/main/install.sh | bash
```

**From a cloned repo:**

```bash
git clone https://github.com/nilcaream/bobai.git
cd bobai
./install.sh
```

The installer builds the server and UI, then places everything under `~/.local/share/bobai/`. It installs the `bobai` command at `~/.local/bin/bobai`.

## Getting Started

### 1. Authenticate a provider

For GitHub Copilot:

```bash
bobai auth github-copilot
```

This runs a device-flow login. Bob AI prints a URL and code. Open the URL in a browser, enter the code, and approve access.

For API-key providers:

```bash
bobai auth openrouter
bobai auth opencode-go
bobai auth opencode-zen
```

Bob AI stores provider credentials in `~/.config/bobai/auth.json`.

If you run `bobai auth` without a provider, Bob AI prints the supported auth provider IDs.

### 2. Start the server

```bash
bobai
```

Bob AI prints a local URL such as:

```text
http://localhost:8080/bobai/
```

Open it in your browser and start chatting.

### 3. Run Bob AI inside a project

Run `bobai` from a project directory. Bob AI creates a `.bobai/` directory there for project state, including:

- project config
- the SQLite session database
- project-local skills
- downloaded web content
- compaction artifacts

All file tools are constrained to the current project plus any explicitly allowed directories.

## CLI Reference

| Command | Description |
|---------|-------------|
| `bobai` | Start the server |
| `bobai auth <provider>` | Authenticate a provider |
| `bobai refresh` | Rebuild the unified model catalog |

| Flag | Description |
|------|-------------|
| `-p <port>`, `--port <port>` | Set server port. By default, Bob AI picks an available port. |
| `--debug` | Enable debug logging and dump files. |

## Model Catalog

Bob AI keeps a single generated model catalog at:

```text
~/.config/bobai/models.json
```

This catalog is grouped by provider and is the source of truth for:

- model IDs
- context windows
- max output tokens
- input/output token prices
- Copilot premium multipliers

Catalog generation rules:

- data comes from `models.dev`
- only Bob AI supported providers are included
- only models with tool support are included
- models with incomplete metadata are skipped
- Copilot token prices are stored as `0`
- Copilot multipliers come from GitHub billing docs when available
- if Copilot multiplier data is unavailable, Bob AI keeps the model and shows `?x`

Startup behavior:

- if `models.json` is missing, Bob AI refreshes it synchronously before the server starts
- if refresh fails and no catalog exists, startup fails
- if refresh fails but a previous catalog exists, Bob AI logs the error and keeps using the stale catalog

Use `bobai refresh` to rebuild the catalog manually.

## Providers and Models

Bob AI supports these runtime providers:

- `github-copilot`
- `openrouter`
- `opencode-go`
- `opencode-zen`

Each provider has a hardcoded default model, but the full selectable model list comes from the generated catalog.

In the UI:

- Copilot models show a premium multiplier such as `0x`, `1x`, or `?x`
- other providers show input/output pricing such as `$0.50 | $5.12`

Use `.model` in chat to switch models for the current session.

## Dot Commands

Type `.` in the prompt to open the dot-command picker. Dot commands are local UI/server commands and are never sent to the LLM.

| Command | Description |
|---------|-------------|
| `.model <n>` | Switch the current session model |
| `.new [title]` | Start a new session |
| `.provider <n>` | Switch the current session provider |
| `.session [n\|text]` | Switch sessions by index or fuzzy title search |
| `.session <n> delete` | Delete a session |
| `.stop` | Cancel the active agent loop |
| `.subagent [n]` | Peek into a subagent session |
| `.title <text>` | Set the current session title |
| `.view [1\|2\|3]` | Cycle between Chat, Context, and Compaction views |

Commands accept unambiguous prefixes, so `.m` matches `.model`, `.v` matches `.view`, and so on.

## Skills

Skills are markdown files named `SKILL.md` with YAML frontmatter. They give the LLM specialized instructions, workflows, or project conventions.

Example:

```yaml
---
name: my-coding-style
description: Enforce project coding conventions
---
Always use tabs for indentation. Prefer named exports...
```

Where to put skills:

| Location | Scope |
|----------|-------|
| `~/.config/bobai/skills/` | Available in every project |
| `<project>/.bobai/skills/` | Available only in that project |

Bob AI scans both directories recursively for `**/SKILL.md`. Project skills override global skills with the same name.

You can use skills in two ways:

- type `/` in the prompt to stage a skill before sending
- let the LLM load a skill dynamically with the `skill` tool

## Plugins

Plugins are `.ts` or `.js` files loaded at startup from:

```text
~/.config/bobai/plugins/
```

Bob AI imports them alphabetically. If a plugin throws during loading, server startup fails.

## Configuration

Bob AI uses layered configuration:

- defaults
- global config
- project config

Project settings override global settings.

**Global config** (`~/.config/bobai/bobai.json`):

```json
{
  "provider": "github-copilot",
  "model": "gpt-5-mini",
  "debug": false,
  "maxIterations": 64
}
```

**Project config** (`<project>/.bobai/bobai.json`):

```json
{
  "id": "...",
  "port": 8080,
  "provider": "opencode-zen",
  "model": "gpt-5.4",
  "maxIterations": 64,
  "debug": false
}
```

Bob AI creates the project config automatically the first time you run it in a directory.

## View Modes

Use `.view` to switch between three views:

1. **Chat** — the normal conversation view
2. **Context** — raw stored messages from the database
3. **Compaction** — the effective message set after compaction and eviction

The Compaction view is the key transparency feature. It shows context pressure, per-message decisions, and exactly what Bob AI removed or shortened.

## Directory Reference

| Path | Purpose |
|------|---------|
| `~/.local/bin/bobai` | Runner script |
| `~/.local/share/bobai/` | Installation home |
| `~/.local/share/bobai/log/` | Rotated log files |
| `~/.config/bobai/auth.json` | Stored provider credentials |
| `~/.config/bobai/bobai.json` | Global config |
| `~/.config/bobai/models.json` | Unified generated model catalog |
| `~/.config/bobai/skills/` | Global skills |
| `~/.config/bobai/plugins/` | Global plugins |
| `<project>/.bobai/` | Project-local Bob AI state |
| `<project>/.bobai/bobai.json` | Project config |
| `<project>/.bobai/bobai.db` | Session database |
| `<project>/.bobai/skills/` | Project-local skills |
| `<project>/.bobai/downloads/` | Downloaded web content |
| `<project>/.bobai/compaction/` | Compaction artifacts |

## Logs

Bob AI writes logs to:

```text
~/.local/share/bobai/log/
```

Files rotate daily and use the format `YYYY-MM-DD.log`.

With `--debug`, Bob AI also writes debug dumps using this naming pattern:

```text
debug-<date>-<time>-<scope>-<code>.txt
```

Examples:

- `debug-*-http.txt` — HTTP request/response dumps
- `debug-*-pre0.txt`, `pre1.txt`, `pre2.txt` — normal compaction snapshots
- `debug-*-emg0.txt`, `emg1.txt`, `emg2.txt` — emergency compaction snapshots

## Tools

The LLM can use these built-in tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite a file |
| `edit_file` | Make targeted file edits |
| `list_directory` | List directory contents |
| `file_search` | Find files by glob pattern |
| `grep_search` | Search file contents with regex |
| `bash` | Run shell commands |
| `sqlite3` | Execute SQL queries against SQLite databases |
| `web_fetch` | Fetch and extract web content |
| `task` | Spawn a subagent for independent work |
| `skill` | Load a skill dynamically |

## Attribution

Favicon based on [Circuit icons created by Prosymbols - Flaticon](https://www.flaticon.com/free-icons/circuit).

Welcome screen ASCII art created with [Text to ASCII Art Generator](https://patorjk.com/software/taag/#p=display&f=Bloody&t=Bob+AI&x=none&v=4&h=4&w=80&we=false).

## License

Apache 2.0
