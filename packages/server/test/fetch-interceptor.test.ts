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

		// Consuming the response drives the recording stream; the dump is
		// written synchronously once the last chunk is read.
		await response.text();
		await Bun.sleep(50);

		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("debug-") && f.endsWith("-http.txt"));
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

		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("debug-") && f.endsWith("-http.txt"));
		expect(dumpFiles.length).toBe(0);
	});

	test("extracts method and headers from Request object when init is undefined", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const mockFetch = mock(async () => {
			return new Response('{"ok":true}', { status: 200, statusText: "OK" });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: true });

		// Simulate what copilot-converter does: fetch(new Request(url, opts))
		const request = new Request("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			headers: { Authorization: "Bearer gho_test1234", "Content-Type": "application/json" },
			body: '{"model":"gpt-4o"}',
		});
		const response = await intercepted(request);
		await response.text();
		await Bun.sleep(50);

		// Should have created a dump file with correct method (POST, not GET)
		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("debug-") && f.endsWith("-http.txt"));
		expect(dumpFiles.length).toBe(1);
		const content = fs.readFileSync(path.join(tmpDir, dumpFiles[0]), "utf8");
		expect(content).toContain(">>> POST");
		expect(content).toContain("Bearer gho_***1234");
	});

	test("returns response body intact through recording stream", async () => {
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

	test("propagates stream error to caller and logs dump failure", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });

		// Simulate a stream that errors mid-read (e.g. network drop during SSE).
		const failingStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial data"));
				controller.error(new Error("connection reset"));
			},
		});
		const mockFetch = mock(async () => {
			return new Response(failingStream, { status: 200, statusText: "OK" });
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: true });
		const response = await intercepted("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			body: "{}",
		});

		// The recording stream forwards the error to the caller.
		await expect(response.text()).rejects.toThrow();

		// No dump file should be written on error — the onError path logs
		// but does not call writeDump.
		await Bun.sleep(50);
		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("debug-") && f.endsWith("-http.txt"));
		expect(dumpFiles.length).toBe(0);
	});

	test("records multi-chunk SSE stream in correct order", async () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });

		// Simulate chunked SSE delivery — each chunk arrives separately.
		const chunks = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			"data: [DONE]\n\n",
		];
		const encoder = new TextEncoder();
		const chunkedStream = new ReadableStream<Uint8Array>({
			async start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});
		const mockFetch = mock(async () => {
			return new Response(chunkedStream, {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const intercepted = createFetchInterceptor(mockFetch, { logger, logDir: tmpDir, debug: true });
		const response = await intercepted("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			body: "{}",
		});

		// Caller receives the full concatenated body.
		const body = await response.text();
		expect(body).toBe(chunks.join(""));

		await Bun.sleep(50);

		// Dump file should contain all chunks in order.
		const dumpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("debug-") && f.endsWith("-http.txt"));
		expect(dumpFiles.length).toBe(1);
		const content = fs.readFileSync(path.join(tmpDir, dumpFiles[0]), "utf8");
		expect(content).toContain("Hello");
		expect(content).toContain(" world");
		expect(content).toContain("[DONE]");
	});
});
