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

# Tests (server only)
cd packages/server && bun test

# Bundle server
bun build --target=bun --minify --outfile=dist/server.js packages/server/src/index.ts

# Build UI
cd packages/ui && bunx vite build
```

## Hard Constraints

- **Never include personally identifiable information** — no names, usernames, or hostnames in tracked files, commit messages, or pull requests.
- Use the `bobai` identifier (or `BobAI` when CamelCase is required) for directories, packages, and code symbols; avoid other spellings such as `bob-ai`.
- **Never commit plan or design docs** (`docs/plans/`). They are local working notes that go stale fast; the directory is gitignored.
