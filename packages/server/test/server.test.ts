import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createTestDb, startTestServer } from "./helpers";

const uiDist = path.resolve(import.meta.dir, "../../ui/dist");

describe("HTTP server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		const started = startTestServer({ port: 0, staticDir: uiDist });
		server = started.server;
		baseUrl = started.baseUrl;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("GET /bobai/health returns 200 with status ok", async () => {
		const res = await fetch(`${baseUrl}/bobai/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	test("GET /bobai/project-info returns dir and optional git info", async () => {
		const res = await fetch(`${baseUrl}/bobai/project-info`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("dir");
		expect(typeof body.dir).toBe("string");
		expect(body.dir.length).toBeGreaterThan(0);
		// git info is optional — if present, validate shape
		if (body.git) {
			expect(typeof body.git.branch).toBe("string");
			expect(typeof body.git.revision).toBe("string");
		}
	});

	test("GET /unknown returns 404", async () => {
		const res = await fetch(`${baseUrl}/unknown`);
		expect(res.status).toBe(404);
	});

	test("GET /bobai serves index.html from static directory", async () => {
		const res = await fetch(`${baseUrl}/bobai`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("Bob AI");
		expect(body).toContain('<div id="root">');
	});

	test("GET /bobai/ serves index.html from static directory", async () => {
		const res = await fetch(`${baseUrl}/bobai/`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("Bob AI");
	});
});

describe("WebSocket server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let wsUrl: string;

	beforeAll(() => {
		const started = startTestServer({ port: 0 });
		server = started.server;
		wsUrl = started.wsUrl;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("accepts WebSocket connection on /bobai/ws", async () => {
		const ws = new WebSocket(wsUrl);

		const connected = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				ws.close();
				resolve();
			};
			ws.onerror = (err) => reject(err);
		});

		await connected;
	});

	test("rejects WebSocket upgrade on non-ws path", async () => {
		const ws = new WebSocket(`ws://localhost:${server.port}/other`);

		const closed = new Promise<number>((resolve) => {
			ws.onclose = (event) => resolve(event.code);
		});

		const code = await closed;
		expect(code).not.toBe(1000);
	});

	test("closing WebSocket during active prompt aborts the agent loop", async () => {
		let streamStarted = false;
		let streamAborted = false;

		const slowProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				streamStarted = true;
				yield { type: "text", text: "Starting..." };
				// Wait until aborted or timeout
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 5000);
					opts.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						streamAborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
				yield { type: "text", text: "Should not reach" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const testDb = createTestDb();
		const started = startTestServer({ port: 0, db: testDb, provider: slowProvider, model: "test" });
		const testServer = started.server;
		const testWsUrl = started.wsUrl;

		try {
			const clientWs = new WebSocket(testWsUrl);
			await new Promise<void>((resolve) => {
				clientWs.onopen = () => resolve();
			});

			// Send a prompt
			clientWs.send(JSON.stringify({ type: "prompt", text: "hello" }));

			// Wait for the provider stream to start
			await new Promise<void>((resolve) => {
				const interval = setInterval(() => {
					if (streamStarted) {
						clearInterval(interval);
						resolve();
					}
				}, 10);
			});

			// Close the WebSocket (simulates page refresh)
			clientWs.close();

			// Wait for abort to propagate
			await new Promise<void>((resolve) => {
				const interval = setInterval(() => {
					if (streamAborted) {
						clearInterval(interval);
						resolve();
					}
				}, 10);
			});

			expect(streamAborted).toBe(true);
		} finally {
			testDb.close();
			testServer.stop(true);
		}
	});
});
