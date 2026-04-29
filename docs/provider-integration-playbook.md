# Provider Integration Playbook

This document is the starting point for adding the next provider.

It assumes the current provider architecture in `packages/server` and applies to **non-Copilot providers**. GitHub Copilot is a special case and should stay in maintenance mode unless a real bug forces changes.

## Goal

Add new providers by composing existing generic pieces instead of inventing new stacks.

Prefer:
- **DRY** — reuse the generic transports and provider plumbing
- **KISS** — keep provider-specific code thin
- **YAGNI** — only add new abstractions when two real providers need them

## Current reusable building blocks

Use these first:

- `src/provider/openai-chat-compatible.ts`
  - For OpenAI-style `/chat/completions` providers
- `src/provider/anthropic-compatible.ts`
  - For Anthropic-style `/messages` providers
- `src/provider/openai-responses-compatible.ts`
  - For OpenAI-style `/responses` providers

Shared provider plumbing:
- `src/provider/registry.ts`
- `src/provider/models.ts`
- `src/provider/factory.ts`
- `src/provider/backend-policy.ts`
- `src/provider/runtime-manager.ts`

Shared auth plumbing:
- `src/auth/authorize.ts`
- `src/auth/store.ts`

## Freeze policy for Copilot

Do not use Copilot as the model for new provider work.

Copilot still works and must keep working, but it is not the template for future providers.
Use the generic transports and the API-key provider pattern instead.

Touch Copilot only if:
1. a bug affects current behavior,
2. an upstream change breaks it,
3. or a tiny extraction gives immediate value elsewhere.

## Integration strategy

Most new providers should follow this order:

1. **Decide scope**
   - Which models are in v1?
   - Which API families are needed?
   - Which models are explicitly deferred?
2. **Use an existing generic transport if possible**
3. **Add provider auth**
4. **Add curated model metadata**
5. **Register the provider in the registry**
6. **Add provider runtime composition**
7. **Add tests**
8. **Run verification**

## Before writing code

Answer these questions first:

### 1. What auth does the provider use?
Usually one of these:
- API key
- OAuth/device flow
- session token exchange

If it is a plain API key, use the existing API-key pattern.
If it is not, stop and decide whether a new auth path is justified.

### 2. Which API family does each model use?
Choose from the current families:
- `openai-chat-completions`
- `anthropic-messages`
- `openai-responses`

If the provider needs a different family, that is a design task, not just plumbing.

### 3. Can v1 be a useful subset?
Prefer a smaller provider with existing transports over a large provider that forces premature abstractions.

Good example:
- support Claude + chat models now
- defer Gemini until there is a second real need for a Gemini transport

## Files to add or update

A typical non-Copilot provider touches these files.

### New files
- `packages/server/src/auth/<provider>.ts`
- `packages/server/src/provider/<provider>-models.ts`
- `packages/server/src/provider/<provider>.ts`
- `packages/server/test/<provider>-auth.test.ts`
- `packages/server/test/<provider>-provider.test.ts`
- `packages/server/test/<provider>-session.test.ts`

### Existing files
- `packages/server/src/auth/authorize.ts`
- `packages/server/src/auth/store.ts`
- `packages/server/src/provider/registry.ts`
- `packages/server/src/provider/factory.ts`

Often also:
- `packages/server/test/provider-registry.test.ts`
- `packages/server/test/provider-descriptor-registry.test.ts`
- `packages/server/test/provider-models.test.ts`
- `packages/server/test/provider-factory.test.ts`
- `packages/server/test/providers-endpoint.test.ts`
- `packages/server/test/backend-policy.test.ts`
- `packages/server/test/provider-command.test.ts`
- `packages/server/test/dot-command.test.ts`

## Recommended implementation pattern

### 1. Auth validator
Create `src/auth/<provider>.ts`.

For API-key providers, keep it simple:
- one smoke-test model
- one validation request
- fail clearly on non-OK response

### 2. Curated models
Create `src/provider/<provider>-models.ts`.

Start with a curated list.
Each model should include at least:
- `id`
- `name`
- `contextWindow`
- `maxOutput`
- `label`
- `enabled`

Prefer explicit metadata over clever inference.

### 3. Runtime composition
Create `src/provider/<provider>.ts`.

Keep the file thin.
Its job is to choose the right generic transport for the model.

Examples:
- chat-only provider:
  - delegate directly to `openai-chat-compatible.ts`
- mixed provider:
  - route by model prefix or model metadata
  - compose chat/messages/responses transports

### 4. Registry entry
Update `src/provider/registry.ts`.

This is the source of truth for:
- provider ID
- default model
- auth messaging
- API family mapping
- model loading
- runtime creation

For API-key providers, use the existing lightweight descriptor pattern.
Do not make Copilot fit that path.

## API-family mapping guidance

Use the smallest clear rule that matches reality.

Good:
- `claude-*` → `anthropic-messages`
- `gpt-*` → `openai-responses`
- everything else → `openai-chat-completions`

Better, when the provider becomes more complex:
- store `apiFamily` in curated model metadata
- read it from there instead of duplicating prefix logic

Do not add that extra metadata until it is useful.

## Testing checklist

Write tests first when adding new behavior.

### Required tests for a new provider

#### Auth
- validation request shape
- non-OK validation failure
- auth store persistence through `authorize.ts`

#### Provider runtime
- correct endpoint chosen
- correct headers used
- correct request body shape
- SSE text streaming
- tool-call streaming if supported
- non-OK response handling

#### Session flow
- provider switch on empty session
- websocket prompt uses the chosen provider
- summary/model metadata stored correctly

#### Shared plumbing
- provider registry exposes the provider
- default model is correct
- family mapping is correct
- model list endpoint includes provider models
- non-empty cross-family model switch is rejected

## Verification commands

For focused provider work, start with targeted tests.

```sh
cd packages/server && bun test \
  test/<provider>-auth.test.ts \
  test/<provider>-provider.test.ts \
  test/<provider>-session.test.ts \
  test/provider-registry.test.ts \
  test/provider-descriptor-registry.test.ts \
  test/provider-models.test.ts \
  test/provider-factory.test.ts \
  test/providers-endpoint.test.ts \
  test/backend-policy.test.ts \
  test/provider-command.test.ts \
  test/dot-command.test.ts
```

Then run the broader provider suite:

```sh
cd packages/server && bun test \
  test/openrouter-provider.test.ts \
  test/openrouter-auth.test.ts \
  test/openrouter-session.test.ts \
  test/provider-descriptor-registry.test.ts \
  test/auth-provider-registry.test.ts \
  test/provider-registry.test.ts \
  test/provider-models.test.ts \
  test/backend-policy.test.ts \
  test/provider-command.test.ts \
  test/provider-factory.test.ts \
  test/providers-endpoint.test.ts \
  test/runtime-manager.test.ts \
  test/authorize.test.ts \
  test/isolated-turn-provider-metadata.test.ts \
  test/isolated-turn.test.ts \
  test/opencode-go-auth.test.ts \
  test/opencode-go-provider.test.ts \
  test/opencode-go-messages-provider.test.ts \
  test/opencode-go-session.test.ts \
  test/opencode-zen-auth.test.ts \
  test/opencode-zen-provider.test.ts \
  test/opencode-zen-session.test.ts \
  test/openai-responses-compatible.test.ts \
  test/responses-stream.test.ts \
  test/responses-convert.test.ts \
  test/handler.test.ts \
  test/dot-command.test.ts

cd packages/server && bun run check -- --error-on-warnings
```

Finally run full repo verification:

```sh
./test.sh
```

## When to refactor

Refactor only when one of these is true:
- two providers need the same new behavior,
- repeated code is already making changes risky,
- or the current shape blocks a real provider integration.

Do **not** refactor because the abstraction looks nicer on paper.

## Rule of thumb

When adding the next non-Copilot provider, aim for this shape:
- thin auth file
- thin curated models file
- thin runtime composition file
- one registry entry
- strong tests
- zero Copilot cleanup unless forced

That is the current happy path.