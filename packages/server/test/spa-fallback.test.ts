import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../src/server";

describe("SPA fallback", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	const tmpDir = path.join(import.meta.dir, "spa-fallback-static.tmp");

	beforeAll(() => {
		// Create a temp static directory with a fake index.html and a real asset
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "index.html"), '<html><body><div id="root"></div></body></html>');
		fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "assets", "app.js"), "console.log('app');");

		server = createServer({ port: 0, staticDir: tmpDir });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("GET /bobai serves index.html", async () => {
		const res = await fetch(`${baseUrl}/bobai`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<div id="root">');
	});

	test("GET /bobai/ serves index.html", async () => {
		const res = await fetch(`${baseUrl}/bobai/`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<div id="root">');
	});

	test("GET /bobai/assets/app.js serves the real file", async () => {
		const res = await fetch(`${baseUrl}/bobai/assets/app.js`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe("console.log('app');");
	});

	test("GET /bobai/<sessionId> falls back to index.html", async () => {
		const res = await fetch(`${baseUrl}/bobai/abc-session-123`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<div id="root">');
	});

	test("GET /bobai/some/deep/path falls back to index.html", async () => {
		const res = await fetch(`${baseUrl}/bobai/some/deep/path`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<div id="root">');
	});

	test("API routes still take precedence over SPA fallback", async () => {
		const res = await fetch(`${baseUrl}/bobai/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});
});
