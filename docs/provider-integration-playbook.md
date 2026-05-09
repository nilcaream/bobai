# Provider Integration Playbook

This document is the starting point for adding the next provider.

It assumes the current provider architecture in `packages/server` and applies to
**non-Copilot providers**. GitHub Copilot is still a special case and should stay
in maintenance mode unless a real bug forces changes.

## Goal

Add providers by composing existing generic pieces instead of inventing new
stacks.

Prefer:

- **DRY** — reuse generic transports and provider plumbing
- **KISS** — keep provider-specific code thin
- **YAGNI** — add new abstractions only when two real providers need them

## Current reusable building blocks

Use these first:

- `src/provider/openai-chat-compatible.ts`
  - for OpenAI-style `/chat/completions` providers
- `src/provider/anthropic-compatible.ts`
  - for Anthropic-style `/messages` providers
- `src/provider/openai-responses-compatible.ts`
  - for OpenAI-style `/responses` providers

All transports **must** include the output token limit in the API request body:

- `max_tokens` for OpenAI chat completions and Anthropic messages
- `max_output_tokens` for OpenAI responses

The value comes from `ProviderOptions.maxOutputTokens`, which is always set by
the agent loop. Providers must not omit it or apply their own fallback — the
single source of truth is the agent loop's computation based on the model
catalog and remaining context window.

Shared provider plumbing:

- `src/provider/registry.ts`
- `src/provider/models.ts`
- `src/provider/factory.ts`
- `src/provider/backend-policy.ts`
- `src/provider/runtime-manager.ts`
- `src/provider/unified-model-catalog.ts`

Shared auth plumbing:

- `src/auth/authorize.ts`
- `src/auth/store.ts`

## Freeze policy for Copilot

Do not use Copilot as the template for new provider work.

Copilot must keep working, but it is no longer the shape for future providers.
Use the generic transports and the API-key provider pattern instead.

Touch Copilot only if:

1. a bug affects current behavior
2. an upstream change breaks it
3. or a tiny extraction gives immediate value elsewhere

## Integration strategy

Most new providers should follow this order:

1. **Decide scope**
   - Which models are in v1?
   - Which API families are needed?
   - Which models are explicitly deferred?
2. **Use an existing generic transport if possible**
3. **Add provider auth**
4. **Register the provider in the registry**
5. **Add provider runtime composition**
6. **Wire the provider into the unified model catalog refresh**
7. **Add tests**
8. **Run verification**

## Before writing code

Answer these questions first.

### 1. What auth does the provider use?

Usually one of these:

- API key
- OAuth or device flow
- session token exchange

If it is a plain API key, use the existing API-key pattern.
If it is not, stop and decide whether a new auth path is justified.

### 2. Which API family does each model use?

Choose from the current families:

- `openai-chat-completions`
- `anthropic-messages`
- `openai-responses`

If the provider needs a different family, that is a design task, not just
plumbing.

### 3. Can v1 be a useful subset?

Prefer a smaller provider with existing transports over a large provider that
forces premature abstractions.

Good example:

- support Claude and chat models now
- defer Gemini until there is a second real need for a Gemini transport

### 4. Where will model metadata come from?

The current architecture uses a single generated global catalog:

- `~/.config/bobai/models.json`

For a new provider, decide:

- whether `models.dev` already exposes the provider
- which upstream provider ID maps to the Bob AI provider ID
- whether the provider's models have complete metadata for strict inclusion

Bob AI no longer uses provider-specific curated model files.

## Files to add or update

A typical non-Copilot provider touches these files.

### New files

- `packages/server/src/auth/<provider>.ts`
- `packages/server/src/provider/<provider>.ts`
- `packages/server/test/<provider>-auth.test.ts`
- `packages/server/test/<provider>-provider.test.ts`
- `packages/server/test/<provider>-session.test.ts`

Sometimes also:

- `packages/server/test/<provider>-messages-provider.test.ts`
- `packages/server/test/<provider>-responses-provider.test.ts`

### Existing files

- `packages/server/src/auth/authorize.ts`
- `packages/server/src/auth/store.ts`
- `packages/server/src/provider/registry.ts`
- `packages/server/src/provider/factory.ts`
- `packages/server/src/provider/unified-model-catalog.ts`

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
- clear failure on non-OK response

### 2. Runtime composition

Create `src/provider/<provider>.ts`.

Keep the file thin. Its job is to choose the correct generic transport for the
model.

Examples:

- chat-only provider
  - delegate directly to `openai-chat-compatible.ts`
- mixed provider
  - route by model prefix or another small rule
  - compose chat, messages, and responses transports

### 3. Registry entry

Update `src/provider/registry.ts`.

This is the source of truth for:

- provider ID
- default model
- auth messaging
- API family mapping
- model loading
- runtime creation
- turn-summary behavior

For API-key providers, use the existing lightweight descriptor pattern.
Do not try to force Copilot into that path.

### 4. Unified catalog integration

Update `src/provider/unified-model-catalog.ts`.

Add:

- provider ID mapping from Bob AI to upstream source
- normalization rules if the provider needs any special handling
- tests that prove the provider is included correctly

Current strict inclusion rules are:

- provider must be supported by Bob AI
- model must support tool usage
- context window must be present
- max output must be present
- input and output prices must be numeric

Do not invent defaults for incomplete upstream data.

## API-family mapping guidance

Use the smallest clear rule that matches reality.

Good:

- `claude-*` → `anthropic-messages`
- `gpt-*` → `openai-responses`
- everything else → `openai-chat-completions`

Better, when the provider becomes more complex:

- add a small shared rule or metadata-driven mapping only when two real
  providers need it

Do not add abstractions because they look cleaner on paper.

## Default model guidance

Model lists are now dynamic, but default models are still hardcoded in the
registry.

For a new provider:

- choose one stable default model ID
- keep that default in `registry.ts`
- do not try to derive the default from the generated catalog

## Testing checklist

Write tests first when adding new behavior.

### Required tests for a new provider

#### Auth

- validation request shape
- non-OK validation failure
- auth-store persistence through `authorize.ts`

#### Provider runtime

- correct endpoint chosen
- correct headers used
- correct request body shape
- `max_tokens` (or equivalent) is present and positive in every request body
- SSE text streaming
- tool-call streaming if supported
- non-OK response handling
- correct status-bar display using unified model metadata

#### Session flow

- provider switch on empty session
- websocket prompt uses the chosen provider
- summary and model metadata stored correctly

#### Shared plumbing

- provider registry exposes the provider
- default model is correct
- family mapping is correct
- model list endpoint includes provider models
- non-empty cross-family model switch is rejected
- unified catalog lookup works for the provider

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

## Safety invariants

These rules apply to every provider transport. Violating them is a bug.

1. **Every API request must include an output token limit.**
   `ProviderOptions.maxOutputTokens` is required and always positive.
   Transports must forward it as `max_tokens`, `max_output_tokens`, or
   the equivalent field for the API family. Never omit it.

2. **Models must have complete metadata to be offered.**
   The unified model catalog rejects models missing `contextWindow` or
   `maxOutput`. Do not invent defaults for incomplete upstream data.
   If a model is missing limits, it does not appear in the model list.

3. **No silent degradation.**
   If a required value is missing at runtime, fail loudly (throw) rather
   than silently proceeding without it. A crash is better than an
   uncontrolled $50 API call.

## When to refactor

Refactor only when one of these is true:

- two providers need the same new behavior
- repeated code is already making changes risky
- the current shape blocks a real provider integration

Do **not** refactor because an abstraction looks nicer on paper.

## Rule of thumb

When adding the next non-Copilot provider, aim for this shape:

- thin auth file
- thin runtime composition file
- one registry entry
- one unified-catalog mapping
- strong tests
- zero Copilot cleanup unless forced

That is the current happy path.
