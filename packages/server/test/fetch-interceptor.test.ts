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
