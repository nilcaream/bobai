# GitHub Copilot User Configuration

> **REQUIRED SUB-SKILL:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `bobai auth` subcommand with optional `--client-id` flag, and support custom HTTP headers in `bobai.json` merged over provider defaults.

**Architecture:** Refactor CLI entry point to detect `auth` subcommand before the normal server startup path. Parameterize `requestDeviceCode` to accept a `clientId` argument (defaulting to Bob AI's registered ID). Add `headers` to the config layer so `bobai.json` entries merge over Copilot's default headers. Simplify `auth.json` to `{ token: "..." }` (drop provider-keyed nesting).

**Tech Stack:** Bun, TypeScript, `bun:test`, Biome (tabs, 128-char line width)

---

### Task 1: Simplify auth store to flat `{ token }` format

The current `auth.json` uses a provider-keyed structure (`{ "github-copilot": { token, type } }`). Since Copilot is the only provider, flatten it to `{ "token": "..." }`. Remove the `providerId` parameter from `saveToken` and `loadToken`.

**Files:**
- Modify: `packages/server/src/auth/store.ts`
- Modify: `packages/server/test/auth-store.test.ts`

**Step 1: Update the tests first**

Replace the test file with tests for the new flat format:

```typescript
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
		saveToken(tmpDir, "gho_abc");
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveToken writes flat token object", () => {
		saveToken(tmpDir, "gho_abc");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual({ token: "gho_abc" });
	});

	test("saveToken overwrites existing token", () => {
		saveToken(tmpDir, "gho_old");
		saveToken(tmpDir, "gho_new");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual({ token: "gho_new" });
	});

	test("loadToken returns token when present", () => {
		saveToken(tmpDir, "gho_abc");
		expect(loadToken(tmpDir)).toBe("gho_abc");
	});

	test("loadToken returns undefined when missing", () => {
		expect(loadToken(tmpDir)).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/auth-store.test.ts`
Expected: FAIL — `saveToken` still expects 3 args.

**Step 3: Update the implementation**

```typescript
import fs from "node:fs";
import path from "node:path";

interface StoredAuth {
	token: string;
}

export function saveToken(configDir: string, token: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	const data: StoredAuth = { token };
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
}

export function loadToken(configDir: string): string | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredAuth;
		return raw.token;
	} catch {
		return undefined;
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/auth-store.test.ts`
Expected: 5 PASS

**Step 5: Commit**

```
feat(server): simplify auth store to flat token format

Drop provider-keyed nesting in auth.json since Copilot is the only
provider. The file is now { "token": "..." } instead of
{ "github-copilot": { "token": "...", "type": "oauth" } }.
```

---

### Task 2: Parameterize `requestDeviceCode` to accept a custom `clientId`

Currently `CLIENT_ID` is a module-level constant. Make it a parameter with Bob AI's ID as default.

**Files:**
- Modify: `packages/server/src/auth/device-flow.ts`
- Modify: `packages/server/test/device-flow.test.ts`

**Step 1: Update the tests**

Add a test that verifies a custom `clientId` is sent in the request body, and update the existing test to verify the default:

In `device-flow.test.ts`, after the existing `"sends correct request and returns parsed response"` test, add:

```typescript
test("uses custom clientId when provided", async () => {
	let capturedBody = "";

	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		capturedBody = init?.body as string;
		return new Response(
			JSON.stringify({
				device_code: "dc_custom",
				user_code: "CUST-1234",
				verification_uri: "https://github.com/login/device",
				interval: 5,
				expires_in: 900,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await requestDeviceCode("Iv1.customclientid");
	const body = JSON.parse(capturedBody);
	expect(body.client_id).toBe("Iv1.customclientid");
});
```

Also update `pollForToken` tests — the poll function also uses `CLIENT_ID` in its POST body. Add a test that verifies it uses a custom `clientId`:

After the existing `"backs off on slow_down then succeeds"` test, add:

```typescript
test("uses custom clientId in token poll", async () => {
	let capturedBody = "";

	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		capturedBody = init?.body as string;
		return new Response(JSON.stringify({ access_token: "gho_custom", token_type: "bearer" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	const noopSleep = async () => {};
	await pollForToken("dc_123", 0, noopSleep, "Iv1.customclientid");
	const body = JSON.parse(capturedBody);
	expect(body.client_id).toBe("Iv1.customclientid");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/device-flow.test.ts`
Expected: FAIL — `requestDeviceCode` doesn't accept args, `pollForToken` 4th arg doesn't exist.

**Step 3: Update the implementation**

In `packages/server/src/auth/device-flow.ts`:

- Export the default client ID as a named constant.
- Add `clientId` parameter to `requestDeviceCode` with default.
- Add `clientId` parameter to `pollForToken` (after `sleep`, with default).

```typescript
export const DEFAULT_CLIENT_ID = "Ov23lilOtSxsmULu7KfI";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

export async function requestDeviceCode(clientId: string = DEFAULT_CLIENT_ID): Promise<DeviceCodeResponse> {
	const response = await fetch(GITHUB_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: clientId,
			scope: "read:user",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	return (await response.json()) as DeviceCodeResponse;
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface TokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

export async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
	clientId: string = DEFAULT_CLIENT_ID,
): Promise<string> {
	let interval = intervalSeconds;

	while (true) {
		if (interval > 0) {
			await sleep(interval * 1000);
		}

		const response = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (!response.ok) {
			throw new Error(`Token poll failed: HTTP ${response.status}`);
		}

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

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/device-flow.test.ts`
Expected: 9 PASS (7 existing + 2 new)

**Step 5: Commit**

```
feat(server): accept custom clientId in device code flow

requestDeviceCode and pollForToken now take an optional clientId
parameter, defaulting to Bob AI's registered OAuth App ID.
```

---

### Task 3: Update `authorize` orchestrator to accept and forward `clientId`

Thread the `clientId` through `authorize()` down to the device flow functions. Also remove the `providerId` parameter since the store no longer needs it.

**Files:**
- Modify: `packages/server/src/auth/authorize.ts`
- Modify: `packages/server/test/authorize.test.ts`

**Step 1: Update the test**

Replace the test to match the new signatures (no `providerId`, optional `clientId`):

```typescript
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

		const token = await authorize(tmpDir);

		expect(token).toBe("gho_final");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.token).toBe("gho_final");
	});

	test("forwards custom clientId to device flow", async () => {
		let capturedBody = "";

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const u = url.toString();
			if (u.includes("/login/device/code")) {
				capturedBody = init?.body as string;
				return new Response(
					JSON.stringify({
						device_code: "dc_custom",
						user_code: "CUST-CODE",
						verification_uri: "https://github.com/login/device",
						interval: 0,
						expires_in: 900,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ access_token: "gho_custom", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await authorize(tmpDir, "Iv1.customid");

		const body = JSON.parse(capturedBody);
		expect(body.client_id).toBe("Iv1.customid");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/authorize.test.ts`
Expected: FAIL — `authorize` expects 2 args (configDir, providerId), not matching new signature.

**Step 3: Update the implementation**

```typescript
import { pollForToken, requestDeviceCode } from "./device-flow";
import { saveToken } from "./store";

export async function authorize(configDir: string, clientId?: string): Promise<string> {
	console.log("Authenticating with GitHub Copilot...\n");

	const deviceCode = await requestDeviceCode(clientId);

	console.log(`  Open: ${deviceCode.verification_uri}`);
	console.log(`  Enter code: ${deviceCode.user_code}\n`);
	console.log("Waiting for authorization...");

	const token = await pollForToken(deviceCode.device_code, deviceCode.interval, undefined, clientId);

	saveToken(configDir, token);
	console.log("Authenticated successfully.\n");

	return token;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/authorize.test.ts`
Expected: 2 PASS

**Step 5: Commit**

```
feat(server): thread clientId through authorize orchestrator

authorize() now accepts an optional clientId that flows through to
requestDeviceCode and pollForToken. Removed providerId parameter
since the auth store no longer uses provider-keyed nesting.
```

---

### Task 4: Add `headers` to config resolution

Add an optional `headers` field to the config layer and `ResolvedConfig`. Headers merge with project overriding global: `{ ...defaults, ...global.headers, ...project.headers }`.

**Files:**
- Modify: `packages/server/src/config/resolve.ts`
- Modify: `packages/server/test/config-resolve.test.ts`
- Modify: `packages/server/src/config/global.ts`
- Modify: `packages/server/test/global-config.test.ts`

**Step 1: Update config resolve tests**

Add tests for header merging in `config-resolve.test.ts`:

```typescript
test("returns empty headers by default", () => {
	const config = resolveConfig({}, {});
	expect(config.headers).toEqual({});
});

test("global headers override defaults", () => {
	const config = resolveConfig({}, { headers: { "User-Agent": "Custom/1.0" } });
	expect(config.headers).toEqual({ "User-Agent": "Custom/1.0" });
});

test("project headers override global headers", () => {
	const config = resolveConfig(
		{ headers: { "User-Agent": "Project/1.0" } },
		{ headers: { "User-Agent": "Global/1.0", "X-Extra": "val" } },
	);
	expect(config.headers).toEqual({ "User-Agent": "Project/1.0", "X-Extra": "val" });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/config-resolve.test.ts`
Expected: FAIL — `headers` not in types/returned config.

**Step 3: Update config resolve implementation**

```typescript
export interface ResolvedConfig {
	provider: string;
	model: string;
	headers: Record<string, string>;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
	headers?: Record<string, string>;
}

const DEFAULTS: ResolvedConfig = {
	provider: "github-copilot",
	model: "gpt-4o",
	headers: {},
};

export function resolveConfig(project: ConfigLayer, global: ConfigLayer): ResolvedConfig {
	return {
		provider: project.provider ?? global.provider ?? DEFAULTS.provider,
		model: project.model ?? global.model ?? DEFAULTS.model,
		headers: { ...DEFAULTS.headers, ...global.headers, ...project.headers },
	};
}
```

**Step 4: Update global config types**

In `packages/server/src/config/global.ts`, add `headers` to `GlobalPreferences`:

```typescript
export interface GlobalPreferences {
	provider?: string;
	model?: string;
	headers?: Record<string, string>;
}
```

**Step 5: Add a global config test for headers**

In `global-config.test.ts`, add:

```typescript
test("reads headers from bobai.json", () => {
	fs.mkdirSync(tmpDir, { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, "bobai.json"),
		JSON.stringify({ headers: { "User-Agent": "Custom/1.0" } }),
	);
	const config = loadGlobalConfig(tmpDir);
	expect(config.preferences.headers).toEqual({ "User-Agent": "Custom/1.0" });
});
```

**Step 6: Run all config tests to verify they pass**

Run: `bun test packages/server/test/config-resolve.test.ts packages/server/test/global-config.test.ts`
Expected: 7 resolve PASS + 4 global PASS

**Step 7: Commit**

```
feat(server): add headers to config resolution

bobai.json now supports a root-level "headers" key. Values merge
with project > global > defaults precedence and flow through to the
provider.
```

---

### Task 5: Wire config headers into Copilot provider

`createCopilotProvider` now accepts a `headers` option. The provider merges its defaults with the user-provided headers (user headers override defaults).

**Files:**
- Modify: `packages/server/src/provider/copilot.ts`
- Modify: `packages/server/test/copilot.test.ts`

**Step 1: Update tests**

Add a test in `copilot.test.ts` that verifies config headers override defaults:

```typescript
test("config headers override default headers", async () => {
	let capturedInit: RequestInit | undefined;

	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		capturedInit = init;
		return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
	}) as typeof fetch;

	const provider = createCopilotProvider("tok", {
		"User-Agent": "CustomAgent/2.0",
		"X-Custom": "value",
	});
	for await (const _ of provider.stream({
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
	})) {
		/* drain */
	}

	const headers = capturedInit?.headers as Record<string, string>;
	expect(headers["User-Agent"]).toBe("CustomAgent/2.0");
	expect(headers["X-Custom"]).toBe("value");
	expect(headers["Openai-Intent"]).toBe("conversation-edits");
});

test("uses default headers when no config headers provided", async () => {
	let capturedInit: RequestInit | undefined;

	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		capturedInit = init;
		return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
	}) as typeof fetch;

	const provider = createCopilotProvider("tok");
	for await (const _ of provider.stream({
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
	})) {
		/* drain */
	}

	const headers = capturedInit?.headers as Record<string, string>;
	expect(headers["User-Agent"]).toMatch(/^bobai\//);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: FAIL — `createCopilotProvider` doesn't accept a second argument.

**Step 3: Update the implementation**

```typescript
import pkg from "../../package.json";
import type { Message, Provider, ProviderOptions } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_API = "https://api.githubcopilot.com/chat/completions";
const USER_AGENT = `bobai/${pkg.version}`;

function resolveInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last?.role === "user" ? "user" : "agent";
}

export function createCopilotProvider(token: string, configHeaders: Record<string, string> = {}): Provider {
	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<string> {
			const defaults: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"Openai-Intent": "conversation-edits",
			};

			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					...defaults,
					...configHeaders,
					Authorization: `Bearer ${token}`,
					"x-initiator": resolveInitiator(options.messages),
				},
				body: JSON.stringify({
					model: options.model,
					messages: options.messages,
					stream: true,
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}

			if (!response.body) {
				return;
			}

			for await (const event of parseSSE(response.body)) {
				const data = event as {
					choices?: { delta?: { content?: string } }[];
				};
				const content = data.choices?.[0]?.delta?.content;
				if (content) yield content;
			}
		},
	};
}
```

Note: `Authorization` and `x-initiator` are placed AFTER the spread so they cannot be accidentally overridden by config headers. `Authorization` is controlled by the auth system, not user config. `x-initiator` is computed per-request.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/copilot.test.ts`
Expected: 7 PASS (5 existing + 2 new)

**Step 5: Commit**

```
feat(server): support custom headers in Copilot provider

createCopilotProvider accepts an optional configHeaders map that
merges over default headers. Authorization and x-initiator remain
non-overridable as they are managed by the auth system.
```

---

### Task 6: Refactor CLI to support `auth` subcommand

Replace the flat `process.argv` flag parsing with a subcommand-aware entry point. `bobai auth` runs the auth flow (with optional `--client-id=X`). `bobai` (no subcommand) runs the server as before.

**Files:**
- Create: `packages/server/src/cli.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/test/cli.test.ts`

**Step 1: Write the tests for CLI argument parsing**

Create `packages/server/test/cli.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseCLI } from "../src/cli";
import { DEFAULT_CLIENT_ID } from "../src/auth/device-flow";

describe("parseCLI", () => {
	test("no arguments returns serve command", () => {
		const result = parseCLI([]);
		expect(result.command).toBe("serve");
		expect(result.debug).toBe(false);
	});

	test("--debug sets debug flag on serve", () => {
		const result = parseCLI(["--debug"]);
		expect(result.command).toBe("serve");
		expect(result.debug).toBe(true);
	});

	test("auth subcommand with defaults", () => {
		const result = parseCLI(["auth"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe(DEFAULT_CLIENT_ID);
	});

	test("auth with --client-id=VALUE", () => {
		const result = parseCLI(["auth", "--client-id=Iv1.custom"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe("Iv1.custom");
	});

	test("auth with --client-id VALUE (space-separated)", () => {
		const result = parseCLI(["auth", "--client-id", "Iv1.custom"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe("Iv1.custom");
	});

	test("auth with --debug", () => {
		const result = parseCLI(["auth", "--debug"]);
		expect(result.command).toBe("auth");
		expect(result.debug).toBe(true);
		expect(result.clientId).toBe(DEFAULT_CLIENT_ID);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/cli.test.ts`
Expected: FAIL — module `../src/cli` not found.

**Step 3: Write the implementation**

Create `packages/server/src/cli.ts`:

```typescript
import { DEFAULT_CLIENT_ID } from "./auth/device-flow";

export interface ServeCommand {
	command: "serve";
	debug: boolean;
}

export interface AuthCommand {
	command: "auth";
	debug: boolean;
	clientId: string;
}

export type CLICommand = ServeCommand | AuthCommand;

export function parseCLI(argv: string[]): CLICommand {
	const debug = argv.includes("--debug");

	if (argv[0] === "auth") {
		return {
			command: "auth",
			debug,
			clientId: parseClientId(argv) ?? DEFAULT_CLIENT_ID,
		};
	}

	return { command: "serve", debug };
}

function parseClientId(argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--client-id") {
			return argv[i + 1];
		}
		if (arg?.startsWith("--client-id=")) {
			return arg.slice("--client-id=".length);
		}
	}
	return undefined;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/cli.test.ts`
Expected: 6 PASS

**Step 5: Commit**

```
feat(server): add CLI parser with auth subcommand support

parseCLI detects "auth" subcommand with optional --client-id flag.
Falls back to "serve" command for normal server startup.
```

---

### Task 7: Wire everything into the entry point

Update `index.ts` to use `parseCLI`, branch on `auth` vs `serve`, pass config headers to the provider, and pass updated store/authorize signatures.

**Files:**
- Modify: `packages/server/src/index.ts`

**Step 1: Rewrite index.ts**

```typescript
import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadToken } from "./auth/store";
import { parseCLI } from "./cli";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { installFetchInterceptor } from "./log/fetch";
import { createLogger } from "./log/logger";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider } from "./provider/copilot";
import { createServer } from "./server";

const cli = parseCLI(process.argv.slice(2));

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const logDir = path.join(dataHome, "bobai", "log");
const logger = createLogger({ level: cli.debug ? "debug" : "info", logDir });
installFetchInterceptor({ logger, logDir, debug: cli.debug });

const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

if (cli.command === "auth") {
	logger.info("AUTH", "Starting authentication flow");
	await authorize(globalConfigDir, cli.clientId);
	process.exit(0);
}

logger.info("SERVER", `Starting bobai (debug=${cli.debug})`);

const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(process.cwd());
const config = resolveConfig({ provider: project.provider, model: project.model }, globalConfig.preferences);

let token = loadToken(globalConfigDir);
if (!token) {
	token = await authorize(globalConfigDir);
}

const provider = createCopilotProvider(token, config.headers);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");
const server = createServer({ port, staticDir, provider, model: config.model });

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${config.provider} / ${config.model}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
```

**Step 2: Run all tests**

Run: `bun test packages/server/`
Expected: All tests pass. Verify no regressions in authorize, auth-store, copilot, config tests.

**Step 3: Commit**

```
feat(server): wire auth subcommand and config headers into startup

bobai auth [--client-id=X] runs the device flow and exits.
bobai (no subcommand) starts the server as before, now passing
config headers to the Copilot provider.
```

---

### Task 8: Final verification

Run all tests, Biome check, and a manual smoke test.

**Step 1: Run full test suite**

Run: `bun test packages/server/`
Expected: All tests pass (previous count was 71, now ~80+).

**Step 2: Run Biome**

Run: `bunx biome check packages/server/src packages/server/test`
Expected: No errors.

**Step 3: Fix any issues found**

If Biome or tests flag problems, fix them.

**Step 4: Commit any fixes**

Only if fixes were needed in step 3.
