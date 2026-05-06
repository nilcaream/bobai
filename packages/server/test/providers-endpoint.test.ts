import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAuthStore } from "../src/auth/store";
import { createServer } from "../src/server";
import { writeUnifiedModelsConfig } from "./test-models";

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
				"opencode-zen": { apiKey: "zen-key" },
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
			{ index: 4, id: "opencode-zen", runtimeSupported: true },
		]);
		expect(body.defaultProvider).toBe("github-copilot");
	});
});

describe("GET /bobai/providers with amazon-bedrock auth", () => {
	let tmpDir: string;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-providers-bedrock-"));
		saveAuthStore(tmpDir, {
			version: 1,
			providers: {
				"github-copilot": { refresh: "r", access: "a", expires: Date.now() + 60_000 },
				"amazon-bedrock": { apiKey: "bedrock-key", region: "us-east-1" },
			},
		});
		server = createServer({ port: 0, configDir: tmpDir, providerId: "github-copilot" });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("includes amazon-bedrock in authenticated providers list", async () => {
		const res = await fetch(`${baseUrl}/bobai/providers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: { index: number; id: string; runtimeSupported: boolean }[];
			defaultProvider: string;
		};
		const ids = body.providers.map((p) => p.id);
		expect(ids).toContain("amazon-bedrock");
	});

	test("providers are listed in a stable canonical order", async () => {
		const res = await fetch(`${baseUrl}/bobai/providers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: { index: number; id: string; runtimeSupported: boolean }[];
		};
		// amazon-bedrock should appear after github-copilot (canonical SUPPORTED_RUNTIME_PROVIDER_IDS order)
		const ids = body.providers.map((p) => p.id);
		const copilotIdx = ids.indexOf("github-copilot");
		const bedrockIdx = ids.indexOf("amazon-bedrock");
		expect(copilotIdx).toBeGreaterThanOrEqual(0);
		expect(bedrockIdx).toBeGreaterThan(copilotIdx);
		// Indices assigned sequentially starting from 1
		for (const [i, provider] of body.providers.entries()) {
			expect(provider.index).toBe(i + 1);
		}
	});
});

describe("GET /bobai/models for amazon-bedrock", () => {
	let tmpDir: string;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-models-bedrock-"));
		saveAuthStore(tmpDir, {
			version: 1,
			providers: {
				"amazon-bedrock": { apiKey: "bedrock-key", region: "us-east-1" },
			},
		});
		writeUnifiedModelsConfig(tmpDir, {
			"amazon-bedrock": [
				{
					id: "anthropic.claude-opus-4-7",
					name: "Claude Opus 4.7",
					contextWindow: 1000000,
					maxOutput: 64000,
					inputPrice: 15,
					outputPrice: 75,
				},
				{
					id: "deepseek.v3-v1:0",
					name: "DeepSeek V3",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0.27,
					outputPrice: 1.1,
				},
			],
		});
		server = createServer({ port: 0, configDir: tmpDir, providerId: "amazon-bedrock" });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns amazon-bedrock model list with cost and context window", async () => {
		const res = await fetch(`${baseUrl}/bobai/models?provider=amazon-bedrock`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.providerId).toBe("amazon-bedrock");
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "anthropic.claude-opus-4-7",
			cost: "$15.00 | $75.00",
			contextWindow: 1000000,
		});
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "deepseek.v3-v1:0",
			cost: "$0.27 | $1.10",
			contextWindow: 131072,
		});
		expect(body.defaultModel).toBe("anthropic.claude-opus-4-7");
		expect(body.defaultStatus).toBe("amazon-bedrock | anthropic.claude-opus-4-7 | $15.00 | $75.00 | 0 / 1000000 | 0%");
	});
});
