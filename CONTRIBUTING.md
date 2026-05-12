# Contributing to Bob AI

Thanks for your interest in contributing. This guide covers what gets merged, how to set up a development environment, and how the contribution process works.

## What Gets Merged

These types of contributions are most likely to be accepted:

- Bug fixes
- New provider support
- Documentation improvements
- Test coverage improvements
- Performance improvements

Changes that affect core architecture, the UI layout, or the session/compaction model need a design discussion before implementation. Open a [GitHub Discussion](https://github.com/nilcaream/bobai/discussions) first to align on the approach.

If you are unsure whether a change is in scope, open a Discussion and ask before writing code.

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

1. **Open an issue** describing the bug or the change you want to make. For bugs, include reproduction steps. For features or refactors, explain the motivation.
2. **Wait for feedback.** A maintainer will confirm whether the change is in scope and suggest an approach if needed.
3. **Fork and implement.** Keep the change focused — one logical change per PR.
4. **Open a PR** referencing the issue. Fill in the PR template.

## Adding a New Provider

Bob AI discovers models from a generated catalog (`~/.config/bobai/models.json`). Adding a provider means:

1. Implementing the provider interface in `packages/server/src/providers/`
2. Adding auth handling in the auth flow
3. Adding model catalog generation for that provider
4. Adding tests

Look at an existing provider (e.g. `openrouter`) as a reference.

## Code Style

Bob AI uses [Biome](https://biomejs.dev) for linting and formatting. Run `bun run check -- --write` in either package to autofix. The CI gate runs with `--error-on-warnings`, so warnings are treated as errors.

## Questions?

Open a [GitHub Discussion](https://github.com/nilcaream/bobai/discussions) — the Q&A category is the right place for usage questions, setup help, and general conversation.
