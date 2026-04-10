# Bob AI — Agent Instructions

## Build & Test

Bun workspace with two packages. Biome config is at the repo root but `check` scripts run per-package.

```sh
# Lint (both packages have the same script)
cd packages/server && bun run check -- --error-on-warnings
cd packages/ui && bun run check -- --error-on-warnings

# Autofix lint issues
cd packages/server && bun run check -- --write
cd packages/ui && bun run check -- --write

# Tests
cd packages/server && bun test
cd packages/ui && bun test

# Type check (UI)
cd packages/ui && bunx tsc --noEmit

# Bundle server
bun build --target=bun --minify --outfile=dist/server.js packages/server/src/index.ts

# Build UI
cd packages/ui && bunx vite build
```

## Glossary

Application vocabulary, UI anatomy, and core concepts are documented in
[`docs/glossary.md`](docs/glossary.md). Read it before any session that
involves UI work, dot commands, or domain concepts — it saves significant
code-diving time.

## Hard Constraints

- **Never include personally identifiable information** — no names, usernames, or hostnames in tracked files, commit messages, or pull requests.
- Use the `bobai` identifier (or `BobAI` when CamelCase is required) for directories, packages, and code symbols; avoid other spellings such as `bob-ai`.
- **Never commit plan or design docs** (`docs/plans/`). They are local working notes that go stale fast; the directory is gitignored.
