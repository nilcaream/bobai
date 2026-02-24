import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

describe("HTTP server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = createServer({ port: 0 });
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

	test("echoes messages back to the client", async () => {
		const received: string[] = [];

		const ws = new WebSocket(wsUrl);

		const done = new Promise<void>((resolve, reject) => {
			ws.onopen = () => ws.send("hello");
			ws.onmessage = (event) => {
				received.push(event.data as string);
				ws.close();
			};
			ws.onclose = () => resolve();
			ws.onerror = (err) => reject(err);
		});

		await done;
		expect(received).toEqual(["hello"]);
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
