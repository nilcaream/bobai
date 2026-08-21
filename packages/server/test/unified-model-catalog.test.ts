import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createModelsDevResponse() {
	return {
		openrouter: {
			id: "openrouter",
			name: "OpenRouter",
			models: {
				"anthropic/claude-sonnet-4": {
					id: "anthropic/claude-sonnet-4",
					name: "Anthropic Claude Sonnet 4",
					tool_call: true,
					limit: { context: 200000, output: 64000 },
					cost: { input: 3, output: 15 },
				},
				"broken/no-output-price": {
					id: "broken/no-output-price",
					name: "Broken Missing Output Price",
					tool_call: true,
					limit: { context: 200000, output: 64000 },
					cost: { input: 3 },
				},
			},
		},
		"opencode-go": {
			id: "opencode-go",
			name: "OpenCode Go",
			models: {
				"deepseek-v4-flash": {
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					tool_call: true,
					limit: { context: 131072, output: 16384 },
					cost: { input: 0.27, output: 1.1 },
				},
			},
		},
		opencode: {
			id: "opencode",
			name: "OpenCode Zen",
			models: {
				"minimax-m2.5-free": {
					id: "minimax-m2.5-free",
					name: "MiniMax M2.5 Free",
					tool_call: true,
					limit: { context: 131072, output: 16384 },
					cost: { input: 0, output: 0 },
				},
				"gemini-3-pro": {
					id: "gemini-3-pro",
					name: "Gemini 3 Pro",
					tool_call: true,
					limit: { context: 1048576, output: 65536 },
					cost: { input: 2, output: 12 },
					provider: { npm: "@ai-sdk/google" },
				},
				"broken/no-context": {
					id: "broken/no-context",
					name: "Broken Missing Context",
					tool_call: true,
					limit: { output: 16384 },
					cost: { input: 1, output: 1 },
				},
			},
		},
	};
}

describe("unified model catalog", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-unified-models-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("refresh builds grouped provider output keyed by Bob AI provider ids", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(createModelsDevResponse())));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		const result = await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(result.configPath).toBe(path.join(tmpDir, "models.json"));
		expect(file.version).toBe(1);
		expect(typeof file.generatedAt).toBe("string");
		expect(Object.keys(file.providers).sort()).toEqual([
			"amazon-bedrock",
			"deepseek",
			"opencode-go",
			"opencode-zen",
			"openrouter",
		]);
	});

	test("strict filtering excludes models without tool support or complete prices and limits", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(createModelsDevResponse())));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(file.providers.openrouter?.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-4"]);
		expect(file.providers["opencode-zen"]?.map((model) => model.id)).toEqual(["minimax-m2.5-free"]);
	});

	test("excludes Gemini (@ai-sdk/google) models that Bob AI cannot serve", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(createModelsDevResponse())));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		const zenIds = file.providers["opencode-zen"]?.map((model) => model.id);
		expect(zenIds).toContain("minimax-m2.5-free");
		expect(zenIds).not.toContain("gemini-3-pro");
	});

	test("populates supportsCaching from models.dev cache costs for all providers", async () => {
		const modelsDev = createModelsDevResponse();
		// Add cache costs to the openrouter sonnet model
		modelsDev.openrouter.models["anthropic/claude-sonnet-4"] = {
			...modelsDev.openrouter.models["anthropic/claude-sonnet-4"],
			cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
		};

		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(modelsDev)));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		// Caching-capable model (has cache costs) → supportsCaching should be true
		const sonnet = file.providers.openrouter?.find((model) => model.id === "anthropic/claude-sonnet-4");
		expect(sonnet?.supportsCaching).toBe(true);

		// Non-caching model (no cache costs) → supportsCaching should be undefined
		const deepseek = file.providers["opencode-go"]?.find((model) => model.id === "deepseek-v4-flash");
		expect(deepseek?.supportsCaching).toBeUndefined();
	});
});
