# Bob AI

A browser-first coding agent powered by GitHub Copilot. Bob AI runs as a local server, connects to the Copilot API, and provides a chat interface with full access to coding tools -- file read/write, search, bash, subagents, and more.

Bob AI's defining feature is **radical context transparency**. You can inspect exactly what the LLM sees: the system prompt, every tool call and result, token usage, and what gets compacted when the context window fills.

## Installation

**Requirements:** Linux x86_64, `git`, `curl`, `unzip`. The installer downloads its own Bun runtime and requires no global Node.js or Bun.

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

The installer downloads Bun, builds the server and UI, and places everything under `~/.local/share/bobai/`. It installs the `bobai` command at `~/.local/bin/bobai` -- add that directory to your `PATH` if it is absent.

## Getting Started

**1. Authenticate with GitHub Copilot:**

```bash
bobai auth
```

This runs an OAuth device flow -- it prints a URL and a code. Open the URL in a browser, enter the code, and authorize. Bob AI saves your token to `~/.config/bobai/auth.json`.

**2. Start the server:**

```bash
bobai
```

Bob AI prints a local URL (e.g. `http://localhost:8080/bobai/`). Open it in your browser and type a prompt to begin.

**3. Start the server in a project directory:**

Run `bobai` from any project directory. Bob AI creates a `.bobai/` folder there for sessions and project-level configuration. All LLM tools operate within that directory.

## CLI Reference

| Command | Description |
|---------|-------------|
| `bobai` | Start the server (default) |
| `bobai auth` | Authenticate with GitHub Copilot |
| `bobai refresh` | Refresh the model list from GitHub |

| Flag | Description |
|------|-------------|
| `-p <port>`, `--port <port>` | Set server port (default: OS picks an available port) |
| `--debug` | Enable debug-level logging and HTTP dump files |

## Dot Commands

Type `.` in the prompt to access dot commands. These local commands control the session and are never sent to the LLM.

| Command | Description |
|---------|-------------|
| `.model <n>` | Switch the LLM model (shows a numbered list) |
| `.new [title]` | Start a new session |
| `.session [n\|text]` | Switch sessions by index or title search |
| `.session <n> delete` | Delete a session |
| `.subagent [n]` | Peek into a subagent session |
| `.title <text>` | Set the current session title |
| `.view [1\|2\|3]` | Cycle between Chat, Context, and Compaction views |

Commands accept abbreviations -- `.m` matches `.model`, `.v` matches `.view`.

### Session Selection

`.session` supports two selection modes:

- **By index:** `.session 3` loads session #3 from the list.
- **By title:** `.session im tes` filters sessions whose title contains both "im" and "tes" (case-insensitive, any order). On submit, the first match is loaded.

Without arguments, `.session` shows the session list. When viewing a subagent, it returns to the parent session.

## Skills

Skills are markdown files (`SKILL.md`) with YAML frontmatter that give the LLM specialized instructions -- coding patterns, workflows, domain knowledge, or any guidance you want the agent to follow.

**Example `SKILL.md`:**

```yaml
---
name: my-coding-style
description: Enforce project coding conventions
---
Always use tabs for indentation. Prefer named exports...
```

**Where to put skills:**

| Location | Scope |
|----------|-------|
| `~/.config/bobai/skills/` | Available in all projects |
| `<project>/.bobai/skills/` | Available only in that project |

Bob AI scans these directories for `**/SKILL.md`. Project skills override global skills when names collide.

**Using skills in a session:**

- Type `/` in the prompt to see available skills and stage one before sending your message.
- The LLM can also load skills on its own via the `skill` tool during a conversation.

## Plugins

Plugins are `.ts` or `.js` files that Bob AI loads at startup. Place them in:

```
~/.config/bobai/plugins/
```

Bob AI loads files alphabetically via dynamic `import()`. If any plugin throws during loading, the server exits.

## Configuration

Bob AI uses layered configuration. Project settings override global settings, which override defaults.

**Global config** (`~/.config/bobai/bobai.json`):

```json
{
  "provider": "github-copilot",
  "model": "gpt-5-mini"
}
```

**Project config** (`<project>/.bobai/bobai.json`):

```json
{
  "id": "...",
  "port": 8080,
  "provider": "github-copilot",
  "model": "claude-sonnet-4.6"
}
```

Bob AI creates the project config automatically when you first run `bobai` in a directory.

### Available Models

| Model | Premium Multiplier |
|-------|-------------------|
| grok-code-fast-1 | 0.25x |
| claude-haiku-4.5 | 0.33x |
| gpt-5.2 | 1x |
| gpt-5.2-codex | 1x |
| gpt-5.3-codex | 1x |
| gpt-5.4 | 1x |
| gemini-2.5-pro | 1x |
| gemini-3.1-pro-preview | 1x |
| gemini-3-flash-preview | 0.33x |
| claude-opus-4.5 | 3x |
| claude-opus-4.6 | 3x |
| claude-sonnet-4.5 | 1x |
| claude-sonnet-4.6 | 1x |
| gpt-5-mini | 0x (default) |
| gpt-5.4-mini | 0.33x |

Preview model IDs are shown as returned by Copilot. For pricing, Bob AI best-matches documented model names when GitHub omits the `-preview` suffix in billing docs.

Use `.model` in the chat to switch models mid-session.

## View Modes

Bob AI has three view modes, accessible via `.view`:

1. **Chat** -- the standard conversation view.
2. **Context** -- raw messages as stored in the database, including every tool call and result.
3. **Compaction** -- what the LLM sees after context compaction, showing which messages were truncated or evicted and why.

The Compaction view is the key transparency feature. It exposes context pressure, per-message age and resistance scores, and exactly what was cut to fit the context window.

## Directory Reference

| Path | Purpose |
|------|---------|
| `~/.local/bin/bobai` | Runner script |
| `~/.local/share/bobai/` | Installation home (Bun binary, bundled dist) |
| `~/.local/share/bobai/log/` | Log files (daily rotation) |
| `~/.config/bobai/auth.json` | OAuth token |
| `~/.config/bobai/bobai.json` | Global config |
| `~/.config/bobai/copilot-models.json` | Cached model metadata |
| `~/.config/bobai/skills/` | Global skills directory |
| `~/.config/bobai/plugins/` | Plugins directory |
| `<project>/.bobai/` | Per-project state |
| `<project>/.bobai/bobai.json` | Project config |
| `<project>/.bobai/bobai.db` | Session database (SQLite) |
| `<project>/.bobai/skills/` | Project-local skills |

## Logs

Bob AI writes logs to `~/.local/share/bobai/log/`, rotating daily. Each file is named `YYYY-MM-DD.log`.

With `--debug`, Bob AI also writes debug dump files to the log directory. All dump files follow a unified naming pattern: `debug-<date>-<time>-<scope>-<code>.txt`.

- **HTTP dumps** (`debug-*-http.txt`) — full API request/response bodies.
- **Compaction dumps** (`debug-*-{pre,emg}{0,1,2}.txt`) — message snapshots before compaction (`0`), after compaction (`1`), and after eviction (`2`).

## Tools

The LLM has access to these tools during a conversation:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite a file |
| `edit_file` | Make targeted edits to a file |
| `list_directory` | List directory contents |
| `file_search` | Find files by glob pattern |
| `grep_search` | Search file contents with regex |
| `bash` | Run shell commands (30s timeout) |
| `task` | Spawn a subagent for independent work |
| `skill` | Load a skill for specialized instructions |

## Attribution

Favicon based on [Circuit icons created by Prosymbols - Flaticon](https://www.flaticon.com/free-icons/circuit).

Welcome screen ASCII art created with [Text to ASCII Art Generator](https://patorjk.com/software/taag/#p=display&f=Bloody&t=Bob+AI&x=none&v=4&h=4&w=80&we=false).

## License

Apache 2.0
