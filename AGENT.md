# Bob AI — Agent Instructions

## Hard Constraints
- **Commit messages must follow Conventional Commits exactly.** Use the `<type>(<scope>): <summary>` format, keep the summary under 72 characters, and ensure the type reflects the change (`feat`, `fix`, `chore`, etc.).
- **Never include personally identifiable information**—avoid names, usernames, hostnames, or any other PII in tracked files, commit messages, or pull requests.
- Use the `bobai` identifier (or `BobAI` when CamelCase is required) for directories, packages, and code symbols; avoid other spellings such as `bob-ai`.

## Product Priorities
- Favor features that expose session context composition (prompt tokens, tool usage, system prompt footprint) so users always see what the agent sees.
- Plan ahead for real-time context compaction and garbage collection; prototyping hooks and telemetry that surface context pressure is preferred over hidden heuristics.
- Use reference implementations only for inspiration. Do not copy external code verbatim—translate ideas into repository-specific implementations.

## Collaboration Notes
- Keep architectural notes and decisions public so future contributors can trace why transparency and compaction features behave the way they do.
- When in doubt about roadmap or scope, open a discussion or issue for clarification before implementing large changes.
