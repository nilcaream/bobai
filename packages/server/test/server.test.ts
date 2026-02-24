import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

const uiDist = path.resolve(import.meta.dir, "../../ui/dist");

describe("HTTP server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = createServer({ port: 0, staticDir: uiDist });
		baseUrl = `http://localhost:${server.port}`;
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
		server = createServer({ port: 0 });
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
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
});
