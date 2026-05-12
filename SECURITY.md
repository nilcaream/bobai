# Security Policy

## Threat Model

Bob AI is a local coding agent. It runs as a server process on your machine under your user account. Understanding the security model helps set correct expectations.

### What Bob AI does

- Runs an HTTP server (REST + WebSocket) bound to localhost by default
- Executes shell commands via the `bash` tool
- Reads and writes files within the current project directory
- Fetches external URLs via the `web_fetch` tool
- Stores provider credentials in `~/.config/bobai/auth.json`

### No authentication, no encryption

The HTTP server uses plain HTTP with no authentication. Any process or user on the same machine that can reach the server port can send requests — including tool calls that execute shell commands. This is intentional for a local developer tool but means:

- **Do not expose the Bob AI port to a network.** If you run it on a machine accessible to others, bind it to localhost only (the default) or firewall the port.
- **Any local process can trigger tool execution.** The server is equivalent in privilege to the user running it. There is no sandbox.

### Credentials

Provider API keys and tokens are stored in plaintext in `~/.config/bobai/auth.json`. Protect this file the same way you protect SSH keys or `.env` files.

### Out of scope

| Category | Rationale |
|---|---|
| Unauthenticated localhost access | The server is intentionally unauthenticated for local use |
| Shell command execution via tools | This is the intended behavior of the `bash` tool |
| LLM provider data handling | Data sent to your configured provider is governed by their policies |
| User-controlled config files | Users control their own config; modifying it is not an attack vector |

## Reporting a Vulnerability

To report a security issue, use the GitHub Security Advisory [Report a Vulnerability](https://github.com/nilcaream/bobai/security/advisories/new) tab. This keeps the report private until a fix is available.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested miigation if you have one

A maintainer will acknowledge the report and follow up on next steps. Please allow reasonable time for a fix before any public disclosure.
