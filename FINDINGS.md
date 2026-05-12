# Findings

Non-trivial behaviour we discovered while building the UI. Each entry
documents a real bug, its root cause, and how we fixed it.

---

## React key reuse across view transitions

**Affected area:** `ToolPanel` collapse detection (`packages/ui/src/App.tsx`)

### The bug

When navigating from a parent session to a subagent, some tool panels
displayed wrong collapse state — short panels appeared collapsed (with
blank space below the text), and tall panels were not collapsible.
Switching the view mode (chat → context → chat) fixed the panels
permanently.

### Root cause

`renderPanels()` assigns positional keys (`key={0}`, `key={1}`, …) to
panel components. When the user navigates to a subagent, two renders
occur in sequence:

1. `setView({ mode: "chat" })` triggers a render with the **parent's**
   messages still in state. React mounts `ToolPanel` instances at keys
   0, 1, 2, … and runs their `useEffect` — measuring the parent's
   panel content.

2. `setMessages(subagentMessages)` triggers a second render. The
   subagent's panels get the same positional keys (0, 1, 2, …). React
   **reuses** the existing `ToolPanel` component instances — it updates
   their props and children, but does **not** remount them. The
   `useEffect` dependency was `[observe]`, which didn't change (it was
   `false` both times). The effect never re-ran. The collapse state
   from the parent's content stuck to the subagent's content.

Switching view modes (chat → context → chat) unmounts all panels and
remounts fresh ones, which is why that sequence fixed the problem.

### Fix

Add a `content` prop (the raw markdown string) to `ToolPanel` and
include it in the effect's dependency array. When React reuses a
component instance but the content has changed, the effect re-runs and
measures the new content.

### Lesson

When using positional keys (`key={n++}`) and the underlying data set
can be swapped entirely (e.g. navigating between views), any `useEffect`
that depends on the rendered content must include a content-derived
value in its dependency array — otherwise React reuses the component
and the effect never re-fires.

---

## `height` vs `max-height` for collapsed panels

**Affected area:** `.panel--tool.panel--collapsed > .md` (CSS)

### The bug

When a short panel (e.g. one line) was incorrectly marked collapsed,
CSS `height: 6em` **stretched** it from its natural ~1em to 6em,
creating visible blank space. Collapsing made the panel bigger instead
of smaller.

### Fix

Use `max-height: 6em` instead of `height: 6em`. A panel shorter than
6em stays at its natural height regardless of collapse state.

---

## Prompt caching: total input vs non-cached input semantics

**Affected area:** All Anthropic-family stream parsers and cost computation (`packages/server/src/provider/`)

### The bug

After enabling prompt caching via `cache_control: { type: "ephemeral" }`,
the turn summary showed nonsensical values like `miss: -237531` and
`in: 4` (total input should have been ~239K). The context progress bar
showed `1 / 200000` — 1 token of 200K used.

### Root cause

The Anthropic API's `input_tokens` field changes semantics when caching
is active. Without caching it means "total input tokens". With caching
it means **only the tokens after the last cache breakpoint** (the
non-cached suffix).

Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

The code was using `input_tokens` as total input everywhere — stream
event `tokenCount`, `onMetrics.promptTokens`, the `miss` calculation,
and the context progress bar.

### Fix

Every stream parser now computes `totalInput = inputTokens + cachedInputTokens + cacheCreationInputTokens` before emitting usage events or calling `onMetrics`.
The `miss` value changed from `totalInput - hit` to `totalInput - hit - write`
(which equals the API's original `input_tokens` — the genuinely non-cached portion).

When caching is disabled, the cache fields are 0, so `totalInput = inputTokens + 0 + 0 = inputTokens` — no behavioral change.

### Lesson

API fields that change semantic meaning based on a feature flag
(caching on/off) need normalization at the boundary layer. Otherwise
every downstream consumer must know whether caching is active.

---

## Bedrock cache pricing gap

**Affected area:** `buildBedrockModels` in `unified-model-catalog.ts`

### The bug

The first cache-enabled turn reported $1.87 for a request that should
have cost ~$0.21. Cache reads were being billed at the full input rate
($3/MTok instead of $0.30/MTok for Claude Sonnet 4.6).

### Root cause

`buildBedrockModels` (used when AWS auth is available) only propagated
`inputPrice` and `outputPrice` from models.dev. It omitted `cacheReadPrice`
and `cacheWritePrice`. The cost function falls back to `inputPrice` for
cache reads/writes when the dedicated prices are absent.

The non-Bedrock path (`normalizeProviderModels`) already included
cache pricing — the gap was specific to the auth-enabled code path.

### Fix

Added cache price propagation to `buildBedrockModels`. Existing
installations need `bobai refresh` to regenerate `models.json`.

---

## Prompt caching and compaction

**Affected area:** Conversation flow, cost expectations

### Behavior

Anthropic's prompt cache is keyed by content hash. When Bob AI
compacts earlier conversation turns into a summary, the cache prefix
hash changes. The next API request cannot read the old cache entry
and must write a fresh one.

```
Turn N (before compaction):   hit: 616K | write: 2.7K
        ← compaction rewrites earlier turns →
Turn N+1 (after compaction):  hit: 0 | write: 69K    ← fresh write
Turn N+2 (no compaction):     hit: 69K | write: 0.2K ← reads from N+1
```

This is expected — cache follows content. The cost impact is one full
cache write after each compaction (~$0.26 for 70K tokens at 1.25x rate),
then subsequent turns within the TTL window read at 10% rate (~$0.02).

The default 5-minute ephemeral TTL (`{ type: "ephemeral" }`) means
the cache expires during gaps longer than 5 minutes (e.g. server
rebuilds). A 1-hour TTL (`{ type: "ephemeral", ttl_seconds: 3600 }`)
would keep cache alive across longer breaks at 2x write cost instead
of 1.25x.
