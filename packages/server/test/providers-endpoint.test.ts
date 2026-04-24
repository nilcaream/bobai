import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAuthStore } from "../src/auth/store";
import { createServer } from "../src/server";

describe("GET /bobai/providers", () => {
	let tmpDir: string;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-providers-"));
		saveAuthStore(tmpDir, {
			version: 1,
			providers: {
				"github-copilot": { refresh: "r", access: "a", expires: Date.now() + 60_000 },
				openrouter: { apiKey: "key" },
				"opencode-go": { apiKey: "go-key" },
			},
		});
		server = createServer({ port: 0, configDir: tmpDir, providerId: "github-copilot" });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("lists authenticated providers with runtime support flags", async () => {
		const res = await fetch(`${baseUrl}/bobai/providers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: { index: number; id: string; runtimeSupported: boolean }[];
			defaultProvider: string;
		};
		expect(body.providers).toEqual([
			{ index: 1, id: "github-copilot", runtimeSupported: true },
			{ index: 2, id: "openrouter", runtimeSupported: true },
			{ index: 3, id: "opencode-go", runtimeSupported: true },
		]);
		expect(body.defaultProvider).toBe("github-copilot");
	});
});
