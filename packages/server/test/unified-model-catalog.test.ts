import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COPILOT_DOC_HTML = `
<table>
  <thead>
    <tr>
      <th>Model</th>
      <th>Multiplier for <strong>paid plans</strong></th>
      <th>Multiplier for <strong>Copilot Free</strong></th>
    </tr>
  </thead>
  <tbody>
    <tr><th scope="row">Claude Sonnet 4.6</th><td>1</td><td>Not applicable</td></tr>
    <tr><th scope="row">GPT-5 mini</th><td>0</td><td>1</td></tr>
  </tbody>
</table>`;

function createModelsDevResponse() {
	return {
		"github-copilot": {
			id: "github-copilot",
			name: "GitHub Copilot",
			models: {
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
			if (urlStr === "https://docs.github.com/en/copilot/concepts/billing/copilot-requests") {
				return Promise.resolve(new Response(COPILOT_DOC_HTML));
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
			"github-copilot",
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
			if (urlStr === "https://docs.github.com/en/copilot/concepts/billing/copilot-requests") {
				return Promise.resolve(new Response(COPILOT_DOC_HTML));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(file.providers["github-copilot"]?.map((model) => model.id)).toEqual(["claude-sonnet-4.6", "gpt-5-mini"]);
		expect(file.providers.openrouter?.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-4"]);
		expect(file.providers["opencode-zen"]?.map((model) => model.id)).toEqual(["minimax-m2.5-free"]);
	});

	test("Copilot token prices are normalized to zero while other providers keep upstream prices", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(createModelsDevResponse())));
			}
			if (urlStr === "https://docs.github.com/en/copilot/concepts/billing/copilot-requests") {
				return Promise.resolve(new Response(COPILOT_DOC_HTML));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(file.providers["github-copilot"]?.find((model) => model.id === "claude-sonnet-4.6")).toMatchObject({
			inputPrice: 0,
			outputPrice: 0,
			premiumRequestMultiplier: 1,
		});
		expect(file.providers.openrouter?.find((model) => model.id === "anthropic/claude-sonnet-4")).toMatchObject({
			inputPrice: 3,
			outputPrice: 15,
		});
	});

	test("refresh still succeeds when Copilot multipliers cannot be fetched", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlStr === "https://models.dev/api.json") {
				return Promise.resolve(new Response(JSON.stringify(createModelsDevResponse())));
			}
			if (urlStr === "https://docs.github.com/en/copilot/concepts/billing/copilot-requests") {
				return Promise.reject(new Error("docs unavailable"));
			}
			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		}) as typeof fetch;

		const { refreshUnifiedModelCatalog, loadUnifiedModelsFile } = await import("../src/provider/unified-model-catalog");
		await refreshUnifiedModelCatalog(tmpDir);
		const file = loadUnifiedModelsFile(tmpDir);

		expect(file.providers["github-copilot"]?.find((model) => model.id === "claude-sonnet-4.6")).toEqual({
			id: "claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			contextWindow: 200000,
			maxOutput: 64000,
			inputPrice: 0,
			outputPrice: 0,
		});
	});
});
