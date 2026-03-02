# Copilot Session Management Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace direct OAuth token usage with proper Copilot session token management — exchange, auto-refresh, model enablement, and dynamic base URL.

**Architecture:** The auth store gains a two-tier token format (refresh + access + expires). The provider manages session lifecycle internally, auto-refreshing before each API call when expired. Token exchange and model enablement are exported functions from `copilot.ts`. Config headers from `bobai.json` flow through all Copilot calls.

**Tech Stack:** Bun, TypeScript, `bun:test` with fetch mocking.

**Design doc:** `docs/plans/2026-03-02-copilot-session-management-design.md`

---

### Task 1: Auth Store — New Format

**Files:**
- Modify: `packages/server/src/auth/store.ts`
- Modify: `packages/server/test/auth-store.test.ts`

**Step 1: Update the tests**

Replace all existing tests. The new `StoredAuth` interface has three fields: `refresh`, `access`, `expires`. Replace `saveToken`/`loadToken` with `saveAuth`/`loadAuth`.

```typescript
// test/auth-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type StoredAuth, loadAuth, saveAuth } from "../src/auth/store";

describe("auth store", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("saveAuth creates auth.json with correct permissions", () => {
		saveAuth(tmpDir, { refresh: "gho_abc", access: "tid=x;exp=y", expires: 1000 });
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveAuth writes all three fields", () => {
		const auth: StoredAuth = { refresh: "gho_abc", access: "tid=x", expires: 99999 };
		saveAuth(tmpDir, auth);
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual(auth);
	});

	test("saveAuth overwrites existing auth", () => {
		saveAuth(tmpDir, { refresh: "old", access: "old", expires: 1 });
		saveAuth(tmpDir, { refresh: "new", access: "new", expires: 2 });
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.refresh).toBe("new");
	});

	test("loadAuth returns auth when present", () => {
		const auth: StoredAuth = { refresh: "gho_abc", access: "tid=x", expires: 99999 };
		saveAuth(tmpDir, auth);
		expect(loadAuth(tmpDir)).toEqual(auth);
	});

	test("loadAuth returns undefined when file is missing", () => {
		expect(loadAuth(tmpDir)).toBeUndefined();
	});

	test("loadAuth returns undefined for old format { token }", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({ token: "gho_old" }));
		expect(loadAuth(tmpDir)).toBeUndefined();
	});

	test("loadAuth returns undefined for corrupt JSON", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), "not json");
		expect(loadAuth(tmpDir)).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/auth-store.test.ts`
Expected: FAIL — `saveAuth` and `loadAuth` do not exist yet.

**Step 3: Implement the new store**

```typescript
// src/auth/store.ts
import fs from "node:fs";
import path from "node:path";

export interface StoredAuth {
	refresh: string;
	access: string;
	expires: number;
}

export function saveAuth(configDir: string, auth: StoredAuth): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	fs.writeFileSync(filePath, JSON.stringify(auth, null, "\t"), { mode: 0o600 });
}

export function loadAuth(configDir: string): StoredAuth | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (typeof raw.refresh === "string" && typeof raw.access === "string" && typeof raw.expires === "number") {
			return { refresh: raw.refresh, access: raw.access, expires: raw.expires };
		}
		return undefined;
	} catch {
		return undefined;
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/auth-store.test.ts`
Expected: All 7 tests PASS.

**Step 5: Commit**

```
feat(auth): replace flat token store with two-tier auth format

Store refresh (GitHub OAuth), access (Copilot session), and expires
fields. Old format returns undefined from loadAuth, forcing re-auth.
```

---

### Task 2: Token Exchange and Base URL Derivation

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Create: `packages/server/test/copilot-session.test.ts`

**Step 1: Write the tests**

Test three things: `deriveBaseUrl()` parses proxy-ep from token strings, `exchangeToken()` calls the right endpoint with right headers and returns parsed result.

```typescript
// test/copilot-session.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { deriveBaseUrl, exchangeToken } from "../src/provider/copilot";

describe("deriveBaseUrl", () => {
	test("extracts base URL from proxy-ep in token", () => {
		const token = "tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom";
		expect(deriveBaseUrl(token)).toBe("https://api.individual.githubcopilot.com");
	});

	test("returns fallback when proxy-ep is missing", () => {
		expect(deriveBaseUrl("tid=abc;exp=123")).toBe("https://api.individual.githubcopilot.com");
	});

	test("handles proxy-ep at end of token without trailing semicolon", () => {
		const token = "tid=abc;proxy-ep=proxy.example.com";
		expect(deriveBaseUrl(token)).toBe("https://api.example.com");
	});
});

describe("exchangeToken", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("exchanges GitHub token for Copilot session token", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(
				JSON.stringify({
					token: "tid=abc;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: 1700000000,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const result = await exchangeToken("gho_test123");

		expect(capturedUrl).toBe("https://api.github.com/copilot_internal/v2/token");
		expect(capturedHeaders.Authorization).toBe("Bearer gho_test123");
		expect(result.access).toBe("tid=abc;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com");
		expect(result.expires).toBe(1700000000 * 1000 - 5 * 60 * 1000);
		expect(result.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	test("merges config headers into exchange request", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(
				JSON.stringify({
					token: "tid=x;exp=1;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: 1700000000,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		await exchangeToken("gho_test", { "User-Agent": "CustomAgent/1.0" });

		expect(capturedHeaders["User-Agent"]).toBe("CustomAgent/1.0");
	});

	test("throws on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		expect(exchangeToken("gho_bad")).rejects.toThrow();
	});

	test("throws on invalid response shape", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
		}) as typeof fetch;

		expect(exchangeToken("gho_bad")).rejects.toThrow();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/copilot-session.test.ts`
Expected: FAIL — `deriveBaseUrl` and `exchangeToken` do not exist.

**Step 3: Implement in copilot.ts**

Add these exports to `packages/server/src/provider/copilot.ts`:

```typescript
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

export function deriveBaseUrl(token: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return DEFAULT_BASE_URL;
	const apiHost = match[1].replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export async function exchangeToken(
	refreshToken: string,
	configHeaders: Record<string, string> = {},
): Promise<{ access: string; expires: number; baseUrl: string }> {
	const defaults: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};

	const response = await fetch(COPILOT_TOKEN_URL, {
		headers: {
			...defaults,
			...configHeaders,
			Authorization: `Bearer ${refreshToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as { token?: unknown; expires_at?: unknown };

	if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
		throw new Error("Invalid token exchange response");
	}

	return {
		access: data.token,
		expires: data.expires_at * 1000 - 5 * 60 * 1000,
		baseUrl: deriveBaseUrl(data.token),
	};
}
```

Also remove the hardcoded `COPILOT_API` constant (it will be replaced by dynamic base URL in Task 4).

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/copilot-session.test.ts`
Expected: All 7 tests PASS.

**Step 5: Commit**

```
feat(copilot): add token exchange and base URL derivation

Exchange GitHub OAuth token for Copilot session token via
api.github.com/copilot_internal/v2/token. Derive API base URL
from the token's proxy-ep field.
```

---

### Task 3: Model Enablement

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Modify: `packages/server/test/copilot-session.test.ts`

**Step 1: Add tests for enableModels**

Append to `copilot-session.test.ts`:

```typescript
import { enableModels } from "../src/provider/copilot";

describe("enableModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("posts to /models/{id}/policy for each model", async () => {
		const urls: string[] = [];
		const bodies: unknown[] = [];

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			urls.push(url.toString());
			bodies.push(JSON.parse(init?.body as string));
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("session-tok", "https://api.individual.githubcopilot.com", ["gpt-4o", "claude-sonnet-4.6"]);

		expect(urls).toContain("https://api.individual.githubcopilot.com/models/gpt-4o/policy");
		expect(urls).toContain("https://api.individual.githubcopilot.com/models/claude-sonnet-4.6/policy");
		expect(bodies[0]).toEqual({ state: "enabled" });
	});

	test("sends session token and correct headers", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("my-session-tok", "https://api.example.com", ["gpt-4o"]);

		expect(capturedHeaders.Authorization).toBe("Bearer my-session-tok");
		expect(capturedHeaders["openai-intent"]).toBe("chat-policy");
		expect(capturedHeaders["x-interaction-type"]).toBe("chat-policy");
	});

	test("merges config headers", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("tok", "https://api.example.com", ["gpt-4o"], { "User-Agent": "CustomAgent/1.0" });

		expect(capturedHeaders["User-Agent"]).toBe("CustomAgent/1.0");
	});

	test("does not throw on individual model failure", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		// Should not throw
		await enableModels("tok", "https://api.example.com", ["gpt-4o", "claude-sonnet-4.6"]);
	});

	test("runs all enablements in parallel", async () => {
		const timestamps: number[] = [];

		globalThis.fetch = mock(async () => {
			timestamps.push(Date.now());
			await Bun.sleep(50);
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("tok", "https://api.example.com", ["a", "b", "c"]);

		// All should start within ~10ms of each other (parallel, not sequential)
		const spread = Math.max(...timestamps) - Math.min(...timestamps);
		expect(spread).toBeLessThan(30);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/copilot-session.test.ts`
Expected: FAIL — `enableModels` does not exist.

**Step 3: Implement enableModels**

Add to `copilot.ts`:

```typescript
export async function enableModels(
	sessionToken: string,
	baseUrl: string,
	modelIds: string[],
	configHeaders: Record<string, string> = {},
): Promise<void> {
	const defaults: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
		"openai-intent": "chat-policy",
		"x-interaction-type": "chat-policy",
	};

	await Promise.all(
		modelIds.map(async (id) => {
			try {
				const response = await fetch(`${baseUrl}/models/${id}/policy`, {
					method: "POST",
					headers: {
						...defaults,
						...configHeaders,
						Authorization: `Bearer ${sessionToken}`,
					},
					body: JSON.stringify({ state: "enabled" }),
				});
				if (response.ok) {
					console.log(`  ${id}: enabled`);
				} else {
					console.log(`  ${id}: failed (${response.status})`);
				}
			} catch (err) {
				console.log(`  ${id}: failed (${err instanceof Error ? err.message : "unknown"})`);
			}
		}),
	);
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/copilot-session.test.ts`
Expected: All 12 tests PASS.

**Step 5: Commit**

```
feat(copilot): add model enablement via policy API

POST /models/{id}/policy with {"state":"enabled"} for each model
in parallel. Failures are non-fatal and logged.
```

---

### Task 4: Provider Session Management

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Modify: `packages/server/test/copilot.test.ts`

This is the largest task. The provider's constructor changes to accept `StoredAuth` and manage session lifecycle.

**Step 1: Update existing provider tests**

All tests that call `createCopilotProvider("tok")` must change to `createCopilotProvider({ refresh: "gho_r", access: "tok", expires: Date.now() + 3600000 })`. The fetch mock also needs to handle the new base URL pattern (`api.individual.githubcopilot.com` instead of `api.githubcopilot.com`).

Additionally, add a new test for auto-refresh:

```typescript
test("auto-refreshes session token when expired", async () => {
	const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr = url.toString();
		fetchCalls.push({ url: urlStr, headers: { ...(init?.headers as Record<string, string>) } });

		// Token exchange endpoint
		if (urlStr.includes("copilot_internal/v2/token")) {
			return new Response(
				JSON.stringify({
					token: "tid=new;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: Math.floor(Date.now() / 1000) + 3600,
				}),
				{ status: 200 },
			);
		}

		// Chat completions endpoint
		return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
	}) as typeof fetch;

	const provider = createCopilotProvider(
		{ refresh: "gho_refresh", access: "expired-tok", expires: Date.now() - 1000 },
		{},
		configDir,  // use a tmp configDir
	);

	for await (const _ of provider.stream({
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
	})) {
		/* drain */
	}

	// Should have called token exchange first, then chat completions
	expect(fetchCalls[0].url).toContain("copilot_internal/v2/token");
	expect(fetchCalls[0].headers.Authorization).toBe("Bearer gho_refresh");
	expect(fetchCalls[1].url).toContain("chat/completions");
	expect(fetchCalls[1].headers.Authorization).toContain("tid=new");
});
```

Also add a test that verifies a non-expired token is used directly without exchange.

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: FAIL — constructor signature changed.

**Step 3: Implement provider session management**

Update `createCopilotProvider` in `copilot.ts`:

```typescript
export function createCopilotProvider(
	auth: StoredAuth,
	configHeaders: Record<string, string> = {},
	configDir?: string,
): Provider {
	const resolvedConfigDir = configDir ?? path.join(os.homedir(), ".config", "bobai");
	let modelsConfig: ModelConfig[] | null = null;

	// Mutable session state
	let sessionToken = auth.access;
	let sessionExpires = auth.expires;
	let baseUrl = deriveBaseUrl(auth.access);
	const refreshToken = auth.refresh;

	async function ensureValidSession(): Promise<void> {
		if (Date.now() < sessionExpires) return;
		const result = await exchangeToken(refreshToken, configHeaders);
		sessionToken = result.access;
		sessionExpires = result.expires;
		baseUrl = result.baseUrl;
		saveAuth(resolvedConfigDir, { refresh: refreshToken, access: sessionToken, expires: sessionExpires });
	}

	// ... loadModelsConfig unchanged ...

	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			await ensureValidSession();

			const defaults: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"Openai-Intent": "conversation-edits",
			};

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					...defaults,
					...configHeaders,
					Authorization: `Bearer ${sessionToken}`,
					"x-initiator": options.initiator ?? resolveInitiator(options.messages),
				},
				// ... body unchanged ...
			});

			// ... rest of streaming logic unchanged ...
		},
	};
}
```

Import `StoredAuth` and `saveAuth` from the auth store.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: All tests PASS (existing + new auto-refresh tests).

**Step 5: Also run the session tests and full suite**

Run: `bun test packages/server/test/`
Expected: All tests PASS.

**Step 6: Commit**

```
feat(copilot): provider manages session token lifecycle

Provider accepts StoredAuth, auto-refreshes expired session tokens
before each API call, persists refreshed tokens, and derives the
API base URL from the token's proxy-ep field.
```

---

### Task 5: Update Authorize and Refresh Commands

**Files:**
- Modify: `packages/server/src/auth/authorize.ts`
- Modify: `packages/server/src/provider/copilot.ts` (update `refreshModels`)
- Modify: `packages/server/test/authorize.test.ts`
- Modify: `packages/server/test/copilot-refresh.test.ts`

**Step 1: Update authorize tests**

The authorize function now does: OAuth → exchange → enable → save. The test mock needs to handle the token exchange endpoint and verify the saved auth format.

**Step 2: Update authorize.ts**

```typescript
import { saveAuth } from "./store";
import { exchangeToken, enableModels } from "../provider/copilot";
import { CURATED_MODELS } from "../provider/copilot-models";

export async function authorize(
	configDir: string,
	clientId?: string,
	configHeaders: Record<string, string> = {},
): Promise<StoredAuth> {
	console.log("Authenticating with GitHub Copilot...\n");

	const deviceCode = await requestDeviceCode(clientId);
	console.log(`  Open: ${deviceCode.verification_uri}`);
	console.log(`  Enter code: ${deviceCode.user_code}\n`);
	console.log("Waiting for authorization...");

	const githubToken = await pollForToken(deviceCode.device_code, deviceCode.interval, undefined, clientId);
	console.log("GitHub authorized. Exchanging for Copilot session...");

	const session = await exchangeToken(githubToken, configHeaders);
	console.log("Session token obtained.\n");

	console.log("Enabling models...");
	await enableModels(session.access, session.baseUrl, [...CURATED_MODELS], configHeaders);

	const auth = { refresh: githubToken, access: session.access, expires: session.expires };
	saveAuth(configDir, auth);
	console.log("\nAuthenticated successfully.\n");

	return auth;
}
```

**Step 3: Update refreshModels**

Change `refreshModels` to accept a session token + base URL + config headers (not a raw OAuth token). Add `enableModels()` call before probing. Update the ping endpoint to use the dynamic base URL.

```typescript
export async function refreshModels(
	sessionToken: string,
	baseUrl: string,
	configDir: string,
	configHeaders: Record<string, string> = {},
): Promise<RefreshResult> {
	console.log("Fetching model catalog from models.dev...");
	const catalog = await fetchCatalog("github-copilot");
	const configs = buildModelConfigs(catalog);

	console.log("Enabling models...");
	await enableModels(sessionToken, baseUrl, configs.map((c) => c.id), configHeaders);

	for (const config of configs) {
		process.stdout.write(`Checking ${config.id}... `);
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
					...configHeaders,
					"Openai-Intent": "conversation-edits",
					Authorization: `Bearer ${sessionToken}`,
					"x-initiator": "agent",
				},
				body: JSON.stringify({
					model: config.id,
					messages: [{ role: "user", content: "Ping. Respond pong." }],
					stream: false,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (response.ok) {
				config.enabled = true;
				console.log("ok");
			} else {
				console.log(`failed (${response.status})`);
			}
		} catch (err) {
			console.log(`failed (${err instanceof Error ? err.message : "unknown error"})`);
		}
	}

	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, "copilot-models.json");
	fs.writeFileSync(configPath, JSON.stringify(configs, null, "\t"));

	const enabled = configs.filter((c) => c.enabled).length;
	console.log(`Wrote ${configs.length} models (${enabled} enabled) to ${configPath}`);

	return { total: configs.length, enabled, configPath };
}
```

**Step 4: Update copilot-refresh tests**

The `mockFetch` helper needs to handle the new `enableModels` calls (POST to `/models/{id}/policy`) in addition to catalog fetches and ping calls. The URL pattern changes from `api.githubcopilot.com` to whatever base URL is passed.

**Step 5: Run all tests**

Run: `bun test packages/server/test/`
Expected: All tests PASS.

**Step 6: Commit**

```
feat(auth): full exchange flow in authorize, enable models in refresh

authorize() now exchanges OAuth token for Copilot session, enables
models, and saves the two-tier auth format. refreshModels() accepts
session token + base URL and enables models before probing.
```

---

### Task 6: Update Entry Point (index.ts)

**Files:**
- Modify: `packages/server/src/index.ts`

**Step 1: Update index.ts**

Key changes:
- `loadAuth()` replaces `loadToken()`
- `auth` and `refresh` commands load global config for headers
- `authorize()` receives config headers
- `refreshModels()` receives session token + base URL + headers
- `createCopilotProvider(auth, config.headers)` replaces `createCopilotProvider(token, config.headers)`
- The `refresh` command needs to check if the session token is expired and re-exchange if needed

```typescript
import { authorize } from "./auth/authorize";
import { loadAuth } from "./auth/store";
import { loadGlobalConfig } from "./config/global";
import { createCopilotProvider, exchangeToken, refreshModels } from "./provider/copilot";

const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

if (cli.command === "auth") {
	const globalConfig = loadGlobalConfig(globalConfigDir);
	const auth = await authorize(globalConfigDir, cli.clientId, globalConfig.headers ?? {});
	const baseUrl = deriveBaseUrl(auth.access);
	await refreshModels(auth.access, baseUrl, globalConfigDir, globalConfig.headers ?? {});
	process.exit(0);
}

if (cli.command === "refresh") {
	let auth = loadAuth(globalConfigDir);
	if (!auth) {
		console.error("No auth found. Run `bobai auth` first.");
		process.exit(1);
	}
	const globalConfig = loadGlobalConfig(globalConfigDir);
	const headers = globalConfig.headers ?? {};
	// Re-exchange if session expired
	if (Date.now() >= auth.expires) {
		const session = await exchangeToken(auth.refresh, headers);
		auth = { refresh: auth.refresh, access: session.access, expires: session.expires };
		saveAuth(globalConfigDir, auth);
	}
	const baseUrl = deriveBaseUrl(auth.access);
	await refreshModels(auth.access, baseUrl, globalConfigDir, headers);
	process.exit(0);
}

// ... serve command ...
let auth = loadAuth(globalConfigDir);
if (!auth) {
	const globalConfig = loadGlobalConfig(globalConfigDir);
	auth = await authorize(globalConfigDir, undefined, globalConfig.headers ?? {});
}

const provider = createCopilotProvider(auth, config.headers);
```

**Step 2: Check that the global config loader exposes headers**

Verify `loadGlobalConfig()` return type includes `headers`. If it currently only returns `preferences`, it may need a small update.

**Step 3: Run full test suite**

Run: `bun test packages/server/test/`
Expected: All tests PASS.

**Step 4: Commit**

```
feat: wire two-tier auth through entry point

auth/refresh commands load global config for headers. Server startup
uses loadAuth() and passes full StoredAuth to provider. refresh
command re-exchanges session token if expired.
```

---

### Task 7: Manual End-to-End Test

**No code changes.** This task verifies the full flow works.

**Step 1: Re-authenticate**

Run: `bun run packages/server/src/index.ts auth --client-id=Iv1.b507a08c87ecfe98`

Verify output shows:
- GitHub device flow
- "Exchanging for Copilot session..."
- "Enabling models..." with per-model status
- Model probe results (expect 7/7 enabled now)

**Step 2: Verify auth.json format**

```bash
cat ~/.config/bobai/auth.json | jq .
```

Verify it has `refresh`, `access`, `expires` fields. The `access` field should contain `tid=...;proxy-ep=...`.

**Step 3: Start the server and test in browser**

Run the server, open the UI, send a message. Verify it works with the session token.

**Step 4: Test with multiple models**

Switch to different models (especially ones that were 403 before: `grok-code-fast-1`, `gpt-4.1`, `gpt-5-mini`) and verify they work.

**Step 5: Commit**

No commit — this is a verification task.
