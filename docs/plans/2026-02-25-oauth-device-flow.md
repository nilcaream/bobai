# OAuth Device Code Flow Implementation Plan

**Goal:** Replace the static PAT auth with GitHub's OAuth Device Code Flow so users can authenticate with `bobai auth` and get a Copilot-compatible token.

**Architecture:** A new `src/auth/device-flow.ts` module handles the RFC 8628 device authorization flow against GitHub's OAuth endpoints. Token is persisted to `~/.config/bobai/auth.json` in the existing format. The startup in `index.ts` detects missing tokens and runs the flow interactively. No new dependencies — uses native `fetch` and `Bun.sleep`.

**Tech Stack:** Bun, TypeScript, GitHub OAuth Device Flow (RFC 8628)

---

### Task 1: Device Flow Core — Request Device Code

**Files:**
- Create: `packages/server/src/auth/device-flow.ts`
- Create: `packages/server/test/device-flow.test.ts`

**Step 1: Write the failing test**

`test/device-flow.test.ts`:
```ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { requestDeviceCode } from "../src/auth/device-flow";

describe("requestDeviceCode", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends correct request and returns parsed response", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				JSON.stringify({
					device_code: "dc_123",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const result = await requestDeviceCode();

		expect(capturedUrl).toBe("https://github.com/login/device/code");
		expect(capturedInit?.method).toBe("POST");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.client_id).toBe("Ov23lilOtSxsmULu7KfI");
		expect(body.scope).toBe("read:user");
		expect(result.device_code).toBe("dc_123");
		expect(result.user_code).toBe("ABCD-1234");
		expect(result.verification_uri).toBe("https://github.com/login/device");
		expect(result.interval).toBe(5);
	});

	test("throws on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Bad Request", { status: 400 });
		}) as typeof fetch;

		expect(requestDeviceCode()).rejects.toThrow("Failed to request device code");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/device-flow.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

`src/auth/device-flow.ts`:
```ts
const CLIENT_ID = "Ov23lilOtSxsmULu7KfI";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
	const response = await fetch(GITHUB_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	return (await response.json()) as DeviceCodeResponse;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/device-flow.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```
feat(server): add device code request for OAuth flow
```

---

### Task 2: Device Flow Core — Poll for Access Token

**Files:**
- Modify: `packages/server/src/auth/device-flow.ts`
- Modify: `packages/server/test/device-flow.test.ts`

**Step 1: Write the failing tests**

Append to `test/device-flow.test.ts`:
```ts
import { pollForToken } from "../src/auth/device-flow";

describe("pollForToken", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns access_token after authorization_pending then success", async () => {
		let callCount = 0;

		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_abc123", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const token = await pollForToken("dc_123", 0);
		expect(token).toBe("gho_abc123");
		expect(callCount).toBe(2);
	});

	test("throws on expired_token error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "expired_token" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		expect(pollForToken("dc_expired", 0)).rejects.toThrow("expired");
	});

	test("throws on access_denied error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "access_denied" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		expect(pollForToken("dc_denied", 0)).rejects.toThrow("denied");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/device-flow.test.ts`
Expected: FAIL — `pollForToken` not exported

**Step 3: Write minimal implementation**

Append to `src/auth/device-flow.ts`:
```ts
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface TokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

export async function pollForToken(deviceCode: string, intervalSeconds: number): Promise<string> {
	let interval = intervalSeconds;

	while (true) {
		if (interval > 0) {
			await Bun.sleep(interval * 1000);
		}

		const response = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const data = (await response.json()) as TokenResponse;

		if (data.access_token) {
			return data.access_token;
		}

		if (data.error === "authorization_pending") {
			continue;
		}

		if (data.error === "slow_down") {
			interval = (data.interval ?? interval) + 5;
			continue;
		}

		throw new Error(data.error_description ?? data.error ?? "Unknown error during token polling");
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/device-flow.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```
feat(server): add token polling for OAuth device flow
```

---

### Task 3: Token Persistence

**Files:**
- Create: `packages/server/src/auth/store.ts`
- Create: `packages/server/test/auth-store.test.ts`
- Modify: `packages/server/src/config/global.ts` — update `AuthEntry` to include OAuth fields

**Step 1: Design the auth.json shape**

The auth.json format evolves from:
```json
{ "github-copilot": { "token": "ghp_xxx" } }
```
to:
```json
{ "github-copilot": { "token": "gho_xxx", "type": "oauth" } }
```

The `type` field is optional for backward compatibility. The `token` field stays the same — it's the usable Bearer token regardless of how it was obtained.

**Step 2: Write the failing tests**

`test/auth-store.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadToken, saveToken } from "../src/auth/store";

describe("auth store", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("saveToken creates auth.json with correct permissions", () => {
		saveToken(tmpDir, "github-copilot", "gho_abc");
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveToken writes provider-keyed token", () => {
		saveToken(tmpDir, "github-copilot", "gho_abc");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw["github-copilot"].token).toBe("gho_abc");
		expect(raw["github-copilot"].type).toBe("oauth");
	});

	test("saveToken preserves existing provider entries", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({ other: { token: "keep" } }));
		saveToken(tmpDir, "github-copilot", "gho_new");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.other.token).toBe("keep");
		expect(raw["github-copilot"].token).toBe("gho_new");
	});

	test("loadToken returns token when present", () => {
		saveToken(tmpDir, "github-copilot", "gho_abc");
		expect(loadToken(tmpDir, "github-copilot")).toBe("gho_abc");
	});

	test("loadToken returns undefined when missing", () => {
		expect(loadToken(tmpDir, "github-copilot")).toBeUndefined();
	});
});
```

**Step 3: Run test to verify it fails**

Run: `bun test test/auth-store.test.ts`
Expected: FAIL — module not found

**Step 4: Write minimal implementation**

`src/auth/store.ts`:
```ts
import fs from "node:fs";
import path from "node:path";

interface StoredAuth {
	token: string;
	type?: string;
}

export function saveToken(configDir: string, providerId: string, token: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");

	let existing: Record<string, StoredAuth> = {};
	try {
		existing = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, StoredAuth>;
	} catch {
		// file doesn't exist or invalid JSON
	}

	existing[providerId] = { token, type: "oauth" };

	fs.writeFileSync(filePath, JSON.stringify(existing, null, "\t"), { mode: 0o600 });
}

export function loadToken(configDir: string, providerId: string): string | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, StoredAuth>;
		return raw[providerId]?.token;
	} catch {
		return undefined;
	}
}
```

**Step 5: Run test to verify it passes**

Run: `bun test test/auth-store.test.ts`
Expected: PASS (5 tests)

**Step 6: Commit**

```
feat(server): add auth token storage with file permissions
```

---

### Task 4: Orchestrate Full Auth Flow

**Files:**
- Create: `packages/server/src/auth/authorize.ts`
- Create: `packages/server/test/authorize.test.ts`

This is the top-level function that ties device-flow + store together and prints user instructions.

**Step 1: Write the failing test**

`test/authorize.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorize } from "../src/auth/authorize";

describe("authorize", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("runs device flow and persists token", async () => {
		let callCount = 0;

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const u = url.toString();
			if (u.includes("/login/device/code")) {
				return new Response(
					JSON.stringify({
						device_code: "dc_test",
						user_code: "TEST-CODE",
						verification_uri: "https://github.com/login/device",
						interval: 0,
						expires_in: 900,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_final", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const token = await authorize(tmpDir, "github-copilot");

		expect(token).toBe("gho_final");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw["github-copilot"].token).toBe("gho_final");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/authorize.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

`src/auth/authorize.ts`:
```ts
import { requestDeviceCode, pollForToken } from "./device-flow";
import { saveToken } from "./store";

export async function authorize(configDir: string, providerId: string): Promise<string> {
	console.log("Authenticating with GitHub Copilot...\n");

	const deviceCode = await requestDeviceCode();

	console.log(`  Open: ${deviceCode.verification_uri}`);
	console.log(`  Enter code: ${deviceCode.user_code}\n`);
	console.log("Waiting for authorization...");

	const token = await pollForToken(deviceCode.device_code, deviceCode.interval);

	saveToken(configDir, providerId, token);
	console.log("Authenticated successfully.\n");

	return token;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/authorize.test.ts`
Expected: PASS (1 test)

**Step 5: Commit**

```
feat(server): add authorize orchestrator for device flow
```

---

### Task 5: Wire Auth into Startup

**Files:**
- Modify: `packages/server/src/index.ts` — replace static token check with interactive auth
- Modify: `packages/server/src/config/global.ts` — remove `AuthEntry` (moved to store)

**Step 1: Update index.ts**

Replace the current token-check block (lines 18-25) with:
```ts
import { loadToken } from "./auth/store";
import { authorize } from "./auth/authorize";

// ... after resolveConfig ...

let token = loadToken(globalConfigDir, config.provider);
if (!token) {
	token = await authorize(globalConfigDir, config.provider);
}

const provider = createCopilotProvider(token);
```

**Step 2: Simplify global.ts**

The `AuthEntry` type and auth reading in `loadGlobalConfig` can stay as-is for now — the `loadToken` in `store.ts` reads auth.json independently, and `loadGlobalConfig` is still used for preferences. Remove the auth field from `GlobalConfig` since startup now uses `loadToken` directly.

Updated `global.ts`:
```ts
import fs from "node:fs";
import path from "node:path";

export interface GlobalPreferences {
	provider?: string;
	model?: string;
}

export interface GlobalConfig {
	preferences: GlobalPreferences;
}

export function loadGlobalConfig(configDir: string): GlobalConfig {
	const preferences = readJson<GlobalPreferences>(path.join(configDir, "bobai.json")) ?? {};
	return { preferences };
}

function readJson<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
```

**Step 3: Update global-config tests**

Remove the `auth` tests and update expectations to match the simplified `GlobalConfig`:
- Remove "reads auth.json keyed by provider id" test
- Update "returns empty config when directory does not exist" expected value
- Update "returns empty objects when files are missing" expected value

**Step 4: Run all tests**

Run: `bun test`
Expected: All pass

**Step 5: Run biome check**

Run: `bunx biome check .`
Expected: Clean

**Step 6: Commit**

```
feat(server): wire OAuth device flow into startup
```

---

### Task 6: Final Verification

**Step 1: Run all tests**

Run: `bun test`
Expected: All pass, 0 failures

**Step 2: Run biome check**

Run: `bunx biome check .`
Expected: Clean, 0 errors

**Step 3: Manual review**

Verify the complete auth flow makes sense:
1. First run → no token → device flow → user authenticates → token saved
2. Second run → token found → skip auth → use stored token
3. Token stored with `0o600` permissions
4. Existing auth.json entries preserved on re-auth
