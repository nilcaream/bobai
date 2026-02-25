# Logging, Payload Dumping, and Integration Test

**Goal:** Add file-based logging with debug payload dumps and a conditional live integration test for the Copilot provider.

**Architecture:** A `src/log/` module provides three pieces: a Logger that writes daily-rotated log files, a dump writer that captures HTTP exchanges in human-readable format, and a fetch interceptor that wraps `globalThis.fetch` to log and dump Copilot API traffic. The `--debug` CLI flag switches from INFO to DEBUG level and enables payload dumps. A separate live test verifies the full Copilot round-trip when auth credentials exist.

**Tech Stack:** Bun, TypeScript, `node:fs` (synchronous append for logging), `ReadableStream.tee()` for non-invasive stream capture.

---

### Task 1: Logger Module

**Files:**
- Create: `packages/server/src/log/logger.ts`
- Create: `packages/server/test/logger.test.ts`

**Step 1: Write the failing tests**

`test/logger.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/log/logger";

describe("logger", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-log-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("creates log directory and writes daily file", () => {
		const logDir = path.join(tmpDir, "nested", "log");
		const logger = createLogger({ level: "debug", logDir });
		logger.info("TEST", "hello world");

		const files = fs.readdirSync(logDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);

		const content = fs.readFileSync(path.join(logDir, files[0]), "utf8");
		expect(content).toContain("INFO  TEST hello world");
	});

	test("formats line as timestamp level system message", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.warn("AUTH", "token expired");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} WARN  AUTH token expired\n$/,
		);
	});

	test("filters messages below configured level", () => {
		const logger = createLogger({ level: "warn", logDir: tmpDir });
		logger.debug("X", "no");
		logger.info("X", "no");
		logger.warn("X", "yes");
		logger.error("X", "yes");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2);
		expect(content).toContain("WARN");
		expect(content).toContain("ERROR");
		expect(content).not.toContain("DEBUG");
		expect(content).not.toContain("INFO");
	});

	test("appends multiple messages to same file", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.info("A", "first");
		logger.info("B", "second");
		logger.debug("C", "third");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content.trim().split("\n").length).toBe(3);
	});
});
```

**Step 2: Run tests — expect FAIL (module not found)**

Run: `bun test packages/server/test/logger.test.ts`

**Step 3: Write implementation**

`src/log/logger.ts`:
```ts
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	readonly level: LogLevel;
	readonly logDir: string;
	debug(system: string, message: string): void;
	info(system: string, message: string): void;
	warn(system: string, message: string): void;
	error(system: string, message: string): void;
}

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export function localTimestamp(): string {
	return new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60 * 1000)
		.toISOString()
		.replace(/[TZ]/g, " ")
		.trim();
}

export function createLogger(options: { level: LogLevel; logDir: string }): Logger {
	const threshold = LEVELS[options.level];
	let dirCreated = false;

	function ensureDir(): void {
		if (dirCreated) return;
		try {
			fs.mkdirSync(options.logDir, { recursive: true });
			dirCreated = true;
		} catch {
			// best effort
		}
	}

	function write(level: LogLevel, system: string, message: string): void {
		if (LEVELS[level] < threshold) return;
		ensureDir();
		const ts = localTimestamp();
		const date = ts.slice(0, 10);
		const filePath = path.join(options.logDir, `${date}.log`);
		const line = `${ts} ${level.toUpperCase().padEnd(5)} ${system} ${message}`;
		try {
			fs.appendFileSync(filePath, `${line}\n`);
		} catch {
			process.stderr.write(`[log] ${line}\n`);
		}
	}

	return {
		level: options.level,
		logDir: options.logDir,
		debug: (system, message) => write("debug", system, message),
		info: (system, message) => write("info", system, message),
		warn: (system, message) => write("warn", system, message),
		error: (system, message) => write("error", system, message),
	};
}
```

**Step 4: Run tests — expect PASS (4 tests)**

Run: `bun test packages/server/test/logger.test.ts`

**Step 5: Commit**

```
feat(server): add file-based logger with daily rotation
```

---

### Task 2: Payload Dump Writer

**Files:**
- Create: `packages/server/src/log/dump.ts`
- Create: `packages/server/test/dump.test.ts`

**Step 1: Write the failing tests**

`test/dump.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskAuthHeader, writeDump } from "../src/log/dump";

describe("writeDump", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-dump-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("creates file matching naming pattern", () => {
		writeDump(
			tmpDir,
			{ method: "POST", url: "https://example.com", headers: {}, body: "{}" },
			{ status: 200, statusText: "OK", headers: {}, body: "ok", latencyMs: 42 },
		);

		const files = fs.readdirSync(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^io-\d{8}_\d{9}-[a-z0-9]{4}\.txt$/);
	});

	test("formats HTTP request and response", () => {
		const filename = writeDump(
			tmpDir,
			{
				method: "POST",
				url: "https://api.githubcopilot.com/chat/completions",
				headers: { "Content-Type": "application/json" },
				body: '{"model":"gpt-4o"}',
			},
			{
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream" },
				body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n',
				latencyMs: 450,
			},
		);

		const content = fs.readFileSync(path.join(tmpDir, filename), "utf8");
		expect(content).toContain(">>> POST https://api.githubcopilot.com/chat/completions");
		expect(content).toContain("Content-Type: application/json");
		expect(content).toContain('{"model":"gpt-4o"}');
		expect(content).toContain("<<< 200 OK (450ms)");
		expect(content).toContain("content-type: text/event-stream");
	});
});

describe("maskAuthHeader", () => {
	test("preserves prefix and last 4 chars of long tokens", () => {
		const masked = maskAuthHeader({ Authorization: "Bearer gho_abcdefghijklmnop" });
		expect(masked.Authorization).toBe("Bearer gho_***mnop");
	});

	test("fully masks short tokens", () => {
		const masked = maskAuthHeader({ Authorization: "Bearer short" });
		expect(masked.Authorization).toBe("Bearer ***");
	});

	test("leaves non-auth headers unchanged", () => {
		const masked = maskAuthHeader({
			"Content-Type": "application/json",
			Authorization: "Bearer gho_abcdefghijkl",
		});
		expect(masked["Content-Type"]).toBe("application/json");
	});
});
```

**Step 2: Run tests — expect FAIL (module not found)**

Run: `bun test packages/server/test/dump.test.ts`

**Step 3: Write implementation**

`src/log/dump.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import { localTimestamp } from "./logger";

export interface DumpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface DumpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	latencyMs: number;
}

function dumpFilename(): string {
	const ts = localTimestamp().replace(/[-: .]/g, "");
	const date = ts.slice(0, 8);
	const time = ts.slice(8);
	const suffix = Math.random().toString(36).substring(2, 6);
	return `io-${date}_${time}-${suffix}.txt`;
}

export function maskAuthHeader(headers: Record<string, string>): Record<string, string> {
	const masked = { ...headers };
	const key = "Authorization" in masked ? "Authorization" : "authorization" in masked ? "authorization" : undefined;
	if (!key) return masked;
	const value = masked[key];
	if (!value.startsWith("Bearer ")) return masked;
	const token = value.slice("Bearer ".length);
	masked[key] = `Bearer ${token.length > 8 ? `${token.slice(0, 4)}***${token.slice(-4)}` : "***"}`;
	return masked;
}

function formatHeaders(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
}

export function writeDump(logDir: string, request: DumpRequest, response: DumpResponse): string {
	const filename = dumpFilename();
	const filePath = path.join(logDir, filename);

	const sections: string[] = [];

	sections.push(`>>> ${request.method} ${request.url}`);
	const reqHeaders = formatHeaders(request.headers);
	if (reqHeaders) sections.push(reqHeaders);
	sections.push("");
	if (request.body) sections.push(request.body);
	sections.push("");

	sections.push(`<<< ${response.status} ${response.statusText} (${response.latencyMs}ms)`);
	const respHeaders = formatHeaders(response.headers);
	if (respHeaders) sections.push(respHeaders);
	sections.push("");
	if (response.body) sections.push(response.body);

	fs.writeFileSync(filePath, sections.join("\n"));
	return filename;
}
```

**Step 4: Run tests — expect PASS (5 tests)**

Run: `bun test packages/server/test/dump.test.ts`

**Step 5: Commit**

```
feat(server): add HTTP payload dump writer with token masking
```

---

### Task 3: Fetch Interceptor

**Files:**
- Create: `packages/server/src/log/fetch.ts`
- Create: `packages/server/test/fetch-interceptor.test.ts`

**Step 1: Write the failing tests**

`test/fetch-interceptor.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFetchInterceptor } from "../src/log/fetch";
import { createLogger } from "../src/log/logger";

describe("fetch interceptor", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-fetch-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("intercepts Copilot API calls and logs them", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const mockFetch = mock(async () => {
			return new Response('{"ok":true}', { status: 200, statusText: "OK" });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: false });
		await intercepted("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			headers: { Authorization: "Bearer gho_test1234" },
			body: '{"model":"gpt-4o"}',
		});

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const logFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		expect(logFiles.length).toBe(1);
		const logContent = fs.readFileSync(path.join(tmpDir, logFiles[0]), "utf8");
		expect(logContent).toContain("githubcopilot.com");
	});

	test("passes through non-GitHub URLs without logging", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const mockFetch = mock(async () => {
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: false });
		await intercepted("https://example.com/api", { method: "GET" });

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const logFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		expect(logFiles.length).toBe(0);
	});

	test("creates dump file in debug mode", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const sseBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
		const mockFetch = mock(async () => {
			return new Response(sseBody, {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: true });
		const response = await intercepted("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			headers: { Authorization: "Bearer gho_abcdefghijkl", "Content-Type": "application/json" },
			body: '{"model":"gpt-4o","stream":true}',
		});

		// Consume response to trigger tee'd dump stream
		await response.text();
		await Bun.sleep(50);

		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("io-"));
		expect(dumpFiles.length).toBe(1);
		const content = fs.readFileSync(path.join(tmpDir, dumpFiles[0]), "utf8");
		expect(content).toContain(">>> POST");
		expect(content).toContain("Bearer gho_***ijkl");
		expect(content).toContain("<<< 200");
	});

	test("skips dump files when debug is off", async () => {
		const logger = createLogger({ level: "info", logDir: tmpDir });
		const mockFetch = mock(async () => {
			return new Response('{"ok":true}', { status: 200, statusText: "OK" });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: false });
		const response = await intercepted("https://api.githubcopilot.com/test", {
			method: "POST",
			body: "{}",
		});
		await response.text();
		await Bun.sleep(50);

		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("io-"));
		expect(dumpFiles.length).toBe(0);
	});

	test("returns response body intact after tee", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const original = '{"result":"test-value"}';
		const mockFetch = mock(async () => {
			return new Response(original, { status: 200, statusText: "OK" });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: true });
		const response = await intercepted("https://api.githubcopilot.com/test", {
			method: "POST",
			body: "{}",
		});

		expect(await response.text()).toBe(original);
	});
});
```

**Step 2: Run tests — expect FAIL (module not found)**

Run: `bun test packages/server/test/fetch-interceptor.test.ts`

**Step 3: Write implementation**

`src/log/fetch.ts`:
```ts
import type { Logger } from "./logger";
import { maskAuthHeader, writeDump } from "./dump";

export interface FetchInterceptorOptions {
	logger: Logger;
	logDir: string;
	debug: boolean;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) return {};
	if (headers instanceof Headers) {
		const result: Record<string, string> = {};
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers } as Record<string, string>;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

export function createFetchInterceptor(
	originalFetch: typeof fetch,
	options: FetchInterceptorOptions,
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (!url.includes("githubcopilot.com") && !url.includes("github.com")) {
			return originalFetch(input, init);
		}

		const method = init?.method ?? "GET";
		const requestBody = typeof init?.body === "string" ? init.body : undefined;
		const startTime = Date.now();

		options.logger.debug("HTTP", `>>> ${method} ${url}`);

		const response = await originalFetch(input, init);
		const latencyMs = Date.now() - startTime;

		options.logger.info("HTTP", `${method} ${url} ${response.status} ${latencyMs}ms`);

		if (!options.debug) return response;

		const reqHeaders = maskAuthHeader(headersToRecord(init?.headers));
		const respHeaders = headersToRecord(response.headers);

		if (response.body) {
			const [callerStream, dumpStream] = response.body.tee();

			collectStream(dumpStream)
				.then((responseBody) => {
					const filename = writeDump(
						options.logDir,
						{ method, url, headers: reqHeaders, body: requestBody },
						{
							status: response.status,
							statusText: response.statusText,
							headers: respHeaders,
							body: responseBody,
							latencyMs,
						},
					);
					options.logger.debug("HTTP", `Dumped to ${filename}`);
				})
				.catch((err) => {
					options.logger.error("HTTP", `Dump failed: ${err}`);
				});

			return new Response(callerStream, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		writeDump(
			options.logDir,
			{ method, url, headers: reqHeaders, body: requestBody },
			{ status: response.status, statusText: response.statusText, headers: respHeaders, body: "", latencyMs },
		);

		return response;
	};
}

export function installFetchInterceptor(options: FetchInterceptorOptions): void {
	globalThis.fetch = createFetchInterceptor(globalThis.fetch, options);
}
```

**Step 4: Run tests — expect PASS (5 tests)**

Run: `bun test packages/server/test/fetch-interceptor.test.ts`

**Step 5: Commit**

```
feat(server): add fetch interceptor for Copilot API logging and dumps
```

---

### Task 4: Wire Logging into Startup

**Files:**
- Modify: `packages/server/src/index.ts`

**Step 1: Update index.ts**

Replace the full file with:
```ts
import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadToken } from "./auth/store";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { installFetchInterceptor } from "./log/fetch";
import { createLogger } from "./log/logger";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider } from "./provider/copilot";
import { createServer } from "./server";

const debug = process.argv.includes("--debug");
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const logDir = path.join(dataHome, "bobai", "log");
const logger = createLogger({ level: debug ? "debug" : "info", logDir });
installFetchInterceptor({ logger, logDir, debug });

logger.info("SERVER", `Starting bobai (debug=${debug})`);

const projectRoot = process.cwd();
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");
const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(projectRoot);
const config = resolveConfig({ provider: project.provider, model: project.model }, globalConfig.preferences);

let token = loadToken(globalConfigDir, config.provider);
if (!token) {
	token = await authorize(globalConfigDir, config.provider);
}

const provider = createCopilotProvider(token);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const server = createServer({ port, staticDir, provider, model: config.model });

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${config.provider} / ${config.model}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
```

**Step 2: Run all tests**

Run: `bun test packages/server/test/`
Expected: All pass

**Step 3: Run biome check**

Run: `bunx biome check .`
Expected: Clean

**Step 4: Commit**

```
feat(server): wire logging and --debug flag into startup
```

---

### Task 5: Conditional Copilot Integration Test

**Files:**
- Create: `packages/server/test/copilot-live.test.ts`

**Step 1: Write the test**

`test/copilot-live.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { loadToken } from "../src/auth/store";
import { createCopilotProvider } from "../src/provider/copilot";

const configDir = path.join(os.homedir(), ".config", "bobai");
const token = loadToken(configDir, "github-copilot");

describe.skipIf(!token)("copilot live", () => {
	test(
		"completes a simple math prompt",
		async () => {
			const provider = createCopilotProvider(token!);
			let result = "";
			for await (const chunk of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "What is 2+7? Return single number." }],
			})) {
				result += chunk;
			}
			expect(result).toContain("9");
		},
		30_000,
	);
});
```

**Step 2: Run the test**

Run: `bun test packages/server/test/copilot-live.test.ts`
Expected: PASS if `~/.config/bobai/auth.json` exists with a valid token, SKIP otherwise.

**Step 3: Run all tests**

Run: `bun test packages/server/test/`
Expected: All pass (live test either passes or is skipped)

**Step 4: Commit**

```
test(server): add conditional live integration test for Copilot
```

---

### Task 6: Final Verification

**Step 1: Run all tests**

Run: `bun test packages/server/test/`
Expected: All pass, 0 failures

**Step 2: Run biome check**

Run: `bunx biome check .`
Expected: Clean, 0 errors

**Step 3: Manual smoke test**

Start the server with debug:
```
bun run packages/server/src/index.ts --debug
```

Send a prompt through the browser. Verify:
1. Log file created at `~/.local/share/bobai/log/YYYY-MM-DD.log`
2. Log contains INFO and DEBUG lines for the HTTP exchange
3. Dump file created at `~/.local/share/bobai/log/io-*.txt`
4. Dump file contains the full HTTP request and masked response
5. Response streams correctly in the browser
