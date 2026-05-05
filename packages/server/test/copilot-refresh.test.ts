import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COPILOT_DOC_HTML = `
<table>
  <tbody>
    <tr><th scope="row">Claude Sonnet 4.6</th><td>1</td><td>Not applicable</td></tr>
    <tr><th scope="row">GPT-5 mini</th><td>0</td><td>1</td></tr>
    <tr><th scope="row">GPT-5.4</th><td>1</td><td>Not applicable</td></tr>
  </tbody>
</table>`;

function catalogResponse() {
	return {
		"github-copilot": {
			id: "github-copilot",
			name: "GitHub Copilot",
			models: {
				"gpt-5.4": {
					id: "gpt-5.4",
					name: "GPT-5.4",
					tool_call: true,
					limit: { context: 128000, output: 16000 },
					cost: { input: 1, output: 4 },
				},
				"claude-sonnet-4.6": {
					id: "claude-sonnet-4.6",
					name: "Claude Sonnet 4.6",
					tool_call: true,
					limit: { context: 200000, output: 64000 },
					cost: { input: 3, output: 15 },
				},
				"gpt-5-mini": {
					id: "gpt-5-mini",
					name: "GPT-5 mini",
					tool_call: true,
					limit: { context: 272000, output: 128000 },
					cost: { input: 0.25, output: 2 },
				},
				"text-only": {
					id: "text-only",
					name: "Text Only",
					tool_call: false,
					limit: { context: 1000, output: 100 },
					cost: { input: 1, output: 1 },
				},
			},
		},
		openrouter: { id: "openrouter", name: "OpenRouter", models: {} },
		"opencode-go": { id: "opencode-go", name: "OpenCode Go", models: {} },
		opencode: { id: "opencode", name: "OpenCode Zen", models: {} },
	};
}

describe("unified model refresh for Copilot", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-refresh-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("writes models.json with normalized Copilot entries", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr.includes("models.dev")) {
				return Promise.resolve(new Response(JSON.stringify(catalogResponse())));
			}
			if (urlStr.includes("docs.github.com")) {
				return Promise.resolve(new Response(COPILOT_DOC_HTML));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		const result = await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(result.configPath).toBe(path.join(tmpDir, "models.json"));
		expect(file.providers["github-copilot"]).toEqual([
			{
				id: "claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				contextWindow: 200000,
				maxOutput: 64000,
				inputPrice: 0,
				outputPrice: 0,
				premiumRequestMultiplier: 1,
			},
			{
				id: "gpt-5-mini",
				name: "GPT-5 mini",
				contextWindow: 272000,
				maxOutput: 128000,
				inputPrice: 0,
				outputPrice: 0,
				premiumRequestMultiplier: 0,
			},
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				contextWindow: 128000,
				maxOutput: 16000,
				inputPrice: 0,
				outputPrice: 0,
				premiumRequestMultiplier: 1,
			},
		]);
	});

	test("excludes non-tool Copilot models during refresh", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr.includes("models.dev")) {
				return Promise.resolve(new Response(JSON.stringify(catalogResponse())));
			}
			if (urlStr.includes("docs.github.com")) {
				return Promise.resolve(new Response(COPILOT_DOC_HTML));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(file.providers["github-copilot"]?.map((model) => model.id)).not.toContain("text-only");
	});

	test("refresh succeeds when multiplier data is unavailable", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr.includes("models.dev")) {
				return Promise.resolve(new Response(JSON.stringify(catalogResponse())));
			}
			if (urlStr.includes("docs.github.com")) {
				return Promise.reject(new Error("docs unavailable"));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		const result = await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(result.multiplierSourceAvailable).toBe(false);
		expect(file.providers["github-copilot"]?.find((model) => model.id === "gpt-5.4")).toEqual({
			id: "gpt-5.4",
			name: "GPT-5.4",
			contextWindow: 128000,
			maxOutput: 16000,
			inputPrice: 0,
			outputPrice: 0,
		});
	});
});
