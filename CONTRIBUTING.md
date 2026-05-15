# Contributing to Bob AI

Bob AI is a solo-maintained project. External contributions are welcome but rare. This guide covers the development workflow.

## Development Setup

**Requirements:** [Bun](https://bun.sh) 1.3+

```bash
git clone https://github.com/nilcaream/bobai.git
cd bobai
bun install
```

Bob AI is a Bun workspace with two packages:

- `packages/server` — the local HTTP/WebSocket server and agent loop
- `packages/ui` — the browser UI (Vite + React)

### Running locally

```bash
# Start the server in watch mode
cd packages/server && bun run dev

# Build the UI in watch mode (separate terminal)
cd packages/ui && bunx vite
```

### Running tests

```bash
# Full suite — lint, typecheck, and tests for both packages
./test.sh

# Per-package tests
cd packages/server && bun test
cd packages/ui && bun test

# Lint (with autofix)
cd packages/server && bun run check -- --write
cd packages/ui && bun run check -- --write

# Type check (UI only)
cd packages/ui && bunx tsc --noEmit
```

All tests must pass before submitting a PR. Coverage thresholds are enforced automatically.

### Building

```bash
# Bundle the server
bun build --target=bun --minify --outfile=dist/server.js packages/server/src/index.ts

# Build the UI
cd packages/ui && bunx vite build
```

## Contribution Process

1. **Open an issue** describing the bug or change. Include reproduction steps for bugs. For features or refactors, explain the motivation.
2. **Wait for feedback.** A maintainer will confirm scope and suggest an approach.
3. **Implement your change** on a branch off `main`. Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.) — the release workflow uses commit messages to generate the changelog automatically.
4. **Open a PR** referencing the issue.
5. Once merged, a maintainer manually triggers a release when enough changes have accumulated. The release workflow bumps the version, builds artifacts, generates the changelog from commits, and publishes an immutable GitHub release.

## CI

CI is purely manual — there are no automatic gates on push or PR. To run CI on any branch:

1. Go to the [Actions tab](https://github.com/nilcaream/bobai/actions/workflows/ci.yml)
2. Click **Run workflow**
3. Select the branch and run

The release workflow runs CI automatically as a gate before publishing.

## Code Style

Bob AI uses [Biome](https://biomejs.dev) for linting and formatting. Run `bun run check -- --write` in either package to autofix. CI treats warnings as errors.

## Adding a New Provider

1. Implement the provider interface in `packages/server/src/providers/`
2. Add auth handling in the auth flow
3. Add model catalog generation for that provider
4. Add tests

Look at an existing provider (e.g., `openrouter`) as a reference.

## Questions?

Open a [GitHub Discussion](https://github.com/nilcaream/bobai/discussions).
