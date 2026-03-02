# Token Counting and Model Discovery

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Display real-time context utilization in the UI status bar, powered by model metadata discovered from models.dev and verified against the Copilot API.

**Architecture:** The Copilot provider extracts `usage` data from SSE response chunks, builds a display string using model metadata from a local JSON config, and streams it to the UI through a new `status` protocol message. Model metadata is populated by a `bobai refresh` CLI action that fetches models.dev, filters by a curated list, and verifies each model with a ping.

**Tech Stack:** TypeScript, Bun, React

---

## Design Decisions

- **Provider builds the display string.** The UI receives and renders text — no structured metadata, no formatting logic. This keeps UI generic and lets each provider decide what to show (tokens, cost, premium requests).
- **Token data comes from the API, not estimation.** Copilot returns `usage` in every final SSE chunk (`prompt_tokens`, `completion_tokens`, `total_tokens`). No tiktoken, no guessing.
- **models.dev is a standalone component.** A generic catalog fetcher that returns normalized `CatalogModel[]` for any provider. Copilot-specific logic (curated list, multipliers, verification) stays in the provider.
- **x-initiator stays inside the provider.** The agent loop does not know about this header. The provider inspects the request body to auto-detect: last message `role === "user"` → `x-initiator: user`, otherwise → `x-initiator: agent`. An explicit override parameter handles the refresh ping case.
- **All curated models use `/chat/completions`.** GPT-5+ codex models (which need `/responses` API) are excluded from the curated list for now.
- **`tokenCount` / `tokenLimit` names** for internal metadata (future compaction, context warnings).

## Curated Model List

| Model | Multiplier | Tier |
|---|---|---|
| gpt-4.1 | 0x | free |
| gpt-5-mini | 0x | free |
| grok-code-fast-1 | 0.25x | cheap |
| claude-haiku-4.5 | 0.33x | cheap |
| claude-sonnet-4.6 | 1x | standard |
| claude-opus-4.6 | 3x | premium |

---

### Task 1: Models Catalog Component

**Files:**
- Create: `packages/server/src/models-catalog.ts`
- Create: `packages/server/test/models-catalog.test.ts`

**Step 1: Write the failing test**

Create `packages/server/test/models-catalog.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { fetchCatalog, type CatalogModel } from "../src/models-catalog";

describe("fetchCatalog", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("extracts models for a known provider", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						"github-copilot": {
							id: "github-copilot",
							name: "GitHub Copilot",
							models: {
								"gpt-4o": {
									id: "gpt-4o",
									name: "GPT-4o",
									limit: { context: 64000, output: 16384 },
								},
								"claude-sonnet-4.6": {
									id: "claude-sonnet-4.6",
									name: "Claude Sonnet 4.6",
									limit: { context: 128000, output: 16000 },
								},
							},
						},
					}),
				),
			),
		);

		const models = await fetchCatalog("github-copilot");
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			id: "gpt-4o",
			name: "GPT-4o",
			contextWindow: 64000,
			maxOutput: 16384,
		});
	});

	test("returns empty array for unknown provider", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({}))),
		);

		const models = await fetchCatalog("nonexistent");
		expect(models).toEqual([]);
	});

	test("throws on network error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network error")));
		expect(fetchCatalog("github-copilot")).rejects.toThrow("network error");
	});
});
```

**Step 2: Implement**

Create `packages/server/src/models-catalog.ts`:

```ts
const MODELS_DEV_URL = "https://models.dev/api.json";

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
}

interface ModelsDevModel {
	id: string;
	name: string;
	limit: { context: number; output: number };
}

interface ModelsDevProvider {
	id: string;
	name: string;
	models: Record<string, ModelsDevModel>;
}

export async function fetchCatalog(providerId: string): Promise<CatalogModel[]> {
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`models.dev returned HTTP ${response.status}`);
	}
	const data = (await response.json()) as Record<string, ModelsDevProvider>;
	const provider = data[providerId];
	if (!provider) return [];

	return Object.values(provider.models).map((m) => ({
		id: m.id,
		name: m.name,
		contextWindow: m.limit.context,
		maxOutput: m.limit.output,
	}));
}
```

**Verify:** `bun test packages/server/test/models-catalog.test.ts`

---

### Task 2: Copilot Model Config — Curated List, Multipliers, Types

**Files:**
- Create: `packages/server/src/provider/copilot-models.ts`
- Create: `packages/server/test/copilot-models.test.ts`

**Step 1: Write the failing test**

Create `packages/server/test/copilot-models.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
	CURATED_MODELS,
	PREMIUM_REQUEST_MULTIPLIERS,
	type ModelConfig,
	buildModelConfigs,
} from "../src/provider/copilot-models";
import type { CatalogModel } from "../src/models-catalog";

describe("copilot model constants", () => {
	test("curated list has 6 models", () => {
		expect(CURATED_MODELS).toHaveLength(6);
	});

	test("every curated model has a multiplier", () => {
		for (const id of CURATED_MODELS) {
			expect(PREMIUM_REQUEST_MULTIPLIERS[id]).toBeDefined();
		}
	});
});

describe("buildModelConfigs", () => {
	test("filters catalog by curated list and attaches multiplier", () => {
		const catalog: CatalogModel[] = [
			{ id: "gpt-4.1", name: "GPT-4.1", contextWindow: 64000, maxOutput: 16384 },
			{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64000, maxOutput: 16384 },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 128000, maxOutput: 16000 },
		];

		const configs = buildModelConfigs(catalog);
		expect(configs).toHaveLength(2); // gpt-4o not in curated list
		expect(configs.find((c) => c.id === "gpt-4.1")).toEqual({
			id: "gpt-4.1",
			name: "GPT-4.1",
			contextWindow: 64000,
			maxOutput: 16384,
			premiumRequestMultiplier: 0,
			enabled: false,
		});
	});

	test("models default to enabled: false before verification", () => {
		const catalog: CatalogModel[] = [
			{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 200000, maxOutput: 16000 },
		];
		const configs = buildModelConfigs(catalog);
		expect(configs[0].enabled).toBe(false);
	});

	test("warns about curated models missing from catalog", () => {
		const configs = buildModelConfigs([]);
		expect(configs).toHaveLength(0);
	});
});
```

**Step 2: Implement**

Create `packages/server/src/provider/copilot-models.ts`:

```ts
import type { CatalogModel } from "../models-catalog";

export interface ModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	premiumRequestMultiplier: number;
	enabled: boolean;
}

export const CURATED_MODELS = [
	"gpt-4.1",
	"gpt-5-mini",
	"grok-code-fast-1",
	"claude-haiku-4.5",
	"claude-sonnet-4.6",
	"claude-opus-4.6",
] as const;

export const PREMIUM_REQUEST_MULTIPLIERS: Record<string, number> = {
	"gpt-4.1": 0,
	"gpt-5-mini": 0,
	"grok-code-fast-1": 0.25,
	"claude-haiku-4.5": 0.33,
	"claude-sonnet-4.6": 1,
	"claude-opus-4.6": 3,
};

export function buildModelConfigs(catalog: CatalogModel[]): ModelConfig[] {
	const curatedSet = new Set<string>(CURATED_MODELS);
	return catalog
		.filter((m) => curatedSet.has(m.id))
		.map((m) => ({
			...m,
			premiumRequestMultiplier: PREMIUM_REQUEST_MULTIPLIERS[m.id] ?? 1,
			enabled: false,
		}));
}
```

**Verify:** `bun test packages/server/test/copilot-models.test.ts`

---

### Task 3: Refresh Action — Fetch, Verify, Write Config

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Create: `packages/server/test/copilot-refresh.test.ts`

This task adds a `refresh()` method to the Copilot provider that:
1. Calls `fetchCatalog("github-copilot")`
2. Filters by curated list via `buildModelConfigs()`
3. Pings each model with `x-initiator: agent` to check availability
4. Writes `~/.config/bobai/copilot-models.json`
5. Logs progress to stdout

**Step 1: Write the failing test**

Create `packages/server/test/copilot-refresh.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { refreshModels, type RefreshResult } from "../src/provider/copilot";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("refreshModels", () => {
	// Test that refresh produces the correct config file.
	// Mock fetch to simulate models.dev and Copilot API responses.
	// The actual file path and fetch mocking details will depend on implementation.
	// Key assertions:
	// - Models from curated list that pass ping get enabled: true
	// - Models that fail ping get enabled: false
	// - File is written to correct location
	// - Returns a summary with counts

	test("enables models that respond to ping", async () => {
		// Implementation will need to mock:
		// 1. fetchCatalog (or the underlying fetch for models.dev)
		// 2. Copilot API ping responses per model
		// Verify the written JSON has correct enabled flags.
	});
});
```

Note: The exact test implementation depends on how we structure the dependencies (inject fetch, inject catalog, etc.). The implementer should write thorough tests covering: successful pings, failed pings, mixed results, network errors during catalog fetch, and file write errors.

**Step 2: Implement**

Add to `packages/server/src/provider/copilot.ts`:

```ts
// New export: refreshModels(token: string)
// 1. const catalog = await fetchCatalog("github-copilot")
// 2. const configs = buildModelConfigs(catalog)
// 3. For each config, ping the Copilot API:
//    POST https://api.githubcopilot.com/chat/completions
//    Headers: Authorization: Bearer <token>, x-initiator: agent,
//             Openai-Intent: conversation-edits
//    Body: { model: config.id, messages: [{role: "user", content: "Ping. Respond pong."}], stream: false }
//    If HTTP 200 + valid response body → config.enabled = true
// 4. Write configs to ~/.config/bobai/copilot-models.json
// 5. Log progress: "Checking <model>... ok/failed (<status>)"
// 6. Log summary: "Wrote N models (M enabled) to <path>"
```

**Step 3: Integrate with CLI**

Wire `bobai refresh` command to call `refreshModels()`. Wire `bobai auth` to call `refreshModels()` after successful authentication.

**Verify:** `bun test packages/server/test/copilot-refresh.test.ts`, then manual `bobai refresh` with a real token.

---

### Task 4: StreamEvent Extension — Usage Variant

**Files:**
- Modify: `packages/server/src/provider/provider.ts`
- Modify: `packages/server/src/provider/copilot.ts`
- Create or modify: `packages/server/test/copilot-stream.test.ts`

**Step 1: Write the failing test**

Extend the provider stream tests to verify that a `usage` event is yielded from the final SSE chunk:

```ts
test("yields usage event from final SSE chunk", async () => {
	// Mock SSE stream ending with:
	// data: {"choices":[{"finish_reason":"stop","delta":{"content":null}}],
	//        "usage":{"prompt_tokens":895,"completion_tokens":37,"total_tokens":932}}
	// Expect the stream to yield:
	// { type: "usage", tokenCount: 932, tokenLimit: 64000, display: "932 / 64000 | 1%" }
	// followed by:
	// { type: "finish", reason: "stop" }
});
```

**Step 2: Implement**

Extend `StreamEvent` in `provider.ts`:

```ts
| { type: "usage"; tokenCount: number; tokenLimit: number; display: string }
```

Modify the Copilot provider's `stream()` method:
1. On startup, read `~/.config/bobai/copilot-models.json` to find the current model's `contextWindow`. Cache this — don't read the file on every call.
2. When parsing the final SSE chunk (the one with `finish_reason`), extract `usage.total_tokens`.
3. Look up `contextWindow` for the current model.
4. Build display string: `"<totalTokens> / <contextWindow> | <percent>%"`
5. Yield `{ type: "usage", tokenCount: totalTokens, tokenLimit: contextWindow, display }` before yielding `finish`.

If the models JSON doesn't exist or doesn't contain the current model, yield usage with `tokenLimit: 0` and display just the token count without percentage.

**Step 3: x-initiator auto-detection**

In the same task, update the `stream()` method signature to accept an optional `initiator` parameter:

```ts
stream(options: ProviderOptions & { initiator?: "user" | "agent" }): AsyncIterable<StreamEvent>
```

Default behavior (no override): inspect `messages[messages.length - 1].role` — `"user"` → `x-initiator: user`, anything else → `x-initiator: agent`.

When `initiator` is explicitly set (refresh ping), use that value directly.

**Verify:** `bun test packages/server/test/copilot-stream.test.ts`

---

### Task 5: Agent Loop — Forward Usage to UI

**Files:**
- Modify: `packages/server/src/agent-loop.ts`
- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/src/handler.ts`

**Step 1: Write the failing test**

Extend agent loop tests to verify that `usage` events are forwarded:

```ts
test("emits status event from provider usage", async () => {
	const events: AgentEvent[] = [];
	// Run agent loop with a provider that yields a usage event.
	// Verify events include { type: "status", text: "932 / 64000 | 1%" }
});
```

**Step 2: Extend AgentEvent**

Add a new variant to `AgentEvent`:

```ts
| { type: "status"; text: string }
```

In the agent loop, when the provider yields `{ type: "usage", ... }`, emit `{ type: "status", text: event.display }` via `onEvent`.

**Step 3: Extend ServerMessage**

Add to `ServerMessage` in `protocol.ts`:

```ts
| { type: "status"; text: string }
```

**Step 4: Wire handler**

In `handler.ts`, map the `status` agent event to the `status` server message:

```ts
case "status":
	send(ws, { type: "status", text: event.text });
	break;
```

**Verify:** `bun test packages/server/test/` — all existing tests pass, new status forwarding tests pass.

---

### Task 6: UI — Status Bar Display

**Files:**
- Modify: `packages/ui/src/useWebSocket.ts`
- Modify: `packages/ui/src/App.tsx`

**Step 1: Extend useWebSocket**

Add `status` to the `ServerMessage` type in `useWebSocket.ts`. Track it as state:

```ts
const [status, setStatus] = useState("");

// In message handler:
case "status":
	setStatus(msg.text);
	break;
```

Expose `status` from the hook.

**Step 2: Update status bar**

In `App.tsx`, update the status bar panel to show the status text on the right:

```tsx
<div className="panel panel--status-bar">
	<span>Bob AI · <span className="dot ..."></span> {connected ? "connected" : "connecting..."}</span>
	<span>{status}</span>
</div>
```

Add `display: flex` and `justify-content: space-between` to `.panel--status-bar` in CSS (or inline if the class already uses flex).

**Step 3: Reset on new conversation**

Clear status when starting a new session (if applicable). For now, status persists until the next provider response updates it — acceptable behavior.

**Verify:** `bun run build` from `packages/ui/`, hard-reload browser, send a prompt, confirm status appears in upper-right corner of status bar after response completes.

---

### Task 7: CLI — Refresh Command and Auth Integration

**Files:**
- Modify: CLI entry point (wherever `bobai auth` and command routing lives)

**Step 1: Add `bobai refresh` command**

Route `bobai refresh` to call the provider's `refreshModels(token)` function. The token comes from the existing OAuth config.

Expected stdout:

```
Fetching model catalog from models.dev...
Checking gpt-4.1... ok
Checking gpt-5-mini... ok
Checking grok-code-fast-1... ok
Checking claude-haiku-4.5... ok
Checking claude-sonnet-4.6... ok
Checking claude-opus-4.6... failed (403)
Wrote 6 models (5 enabled) to ~/.config/bobai/copilot-models.json
```

**Step 2: Auto-refresh after auth**

After successful `bobai auth`, call the refresh flow automatically. The user sees auth succeed, then model verification runs.

**Verify:** Run `bobai refresh` manually. Run `bobai auth` and confirm refresh runs after authentication completes.
