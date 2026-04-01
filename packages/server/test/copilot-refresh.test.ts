import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshModels } from "../src/provider/copilot";

// Minimal catalog response that includes curated models
function catalogResponse(modelIds: string[]) {
	const models: Record<string, object> = {};
	for (const id of modelIds) {
		models[id] = {
			id,
			name: id.toUpperCase(),
			limit: { context: 128000, output: 16000 },
		};
	}
	return {
		"github-copilot": {
			id: "github-copilot",
			name: "GitHub Copilot",
			models,
		},
	};
}

const TEST_BASE_URL = "https://api.individual.githubcopilot.com";

function mockFetch(pingResults: Record<string, number | Error>) {
	return mock((url: string | URL | Request, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

		// models.dev catalog fetch
		if (urlStr.includes("models.dev")) {
			return Promise.resolve(new Response(JSON.stringify(catalogResponse(Object.keys(pingResults)))));
		}

		// enableModels policy calls
		if (urlStr.includes("/models/") && urlStr.includes("/policy")) {
			return Promise.resolve(new Response(null, { status: 200 }));
		}

		// Copilot API ping
		if (urlStr.includes("api.individual.githubcopilot.com")) {
			const body = JSON.parse(init?.body as string);
			const result = pingResults[body.model];
			if (result instanceof Error) {
				return Promise.reject(result);
			}
			return Promise.resolve(new Response(null, { status: result }));
		}

		return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
	});
}

describe("refreshModels", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-refresh-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("models that respond to ping get enabled: true", async () => {
		globalThis.fetch = mockFetch({ "gpt-4.1": 200, "claude-sonnet-4.6": 200 });

		const result = await refreshModels("fake-token", TEST_BASE_URL, tmpDir);
		const configs = JSON.parse(fs.readFileSync(path.join(tmpDir, "copilot-models.json"), "utf8"));

		expect(configs.every((c: { enabled: boolean }) => c.enabled)).toBe(true);
		expect(result.enabled).toBe(2);
	});

	test("models that fail ping get enabled: false", async () => {
		globalThis.fetch = mockFetch({ "gpt-4.1": 403, "claude-sonnet-4.6": 403 });

		const result = await refreshModels("fake-token", TEST_BASE_URL, tmpDir);
		const configs = JSON.parse(fs.readFileSync(path.join(tmpDir, "copilot-models.json"), "utf8"));

		expect(configs.every((c: { enabled: boolean }) => !c.enabled)).toBe(true);
		expect(result.enabled).toBe(0);
	});

	test("mixed results — some pass, some fail", async () => {
		globalThis.fetch = mockFetch({ "gpt-4.1": 200, "claude-sonnet-4.6": 403 });

		const result = await refreshModels("fake-token", TEST_BASE_URL, tmpDir);
		const configs = JSON.parse(fs.readFileSync(path.join(tmpDir, "copilot-models.json"), "utf8"));

		const gpt = configs.find((c: { id: string }) => c.id === "gpt-4.1");
		const claude = configs.find((c: { id: string }) => c.id === "claude-sonnet-4.6");
		expect(gpt.enabled).toBe(true);
		expect(claude.enabled).toBe(false);
		expect(result.enabled).toBe(1);
		expect(result.total).toBe(2);
	});

	test("config file is written with correct structure", async () => {
		globalThis.fetch = mockFetch({ "gpt-4.1": 200 });

		await refreshModels("fake-token", TEST_BASE_URL, tmpDir);
		const configs = JSON.parse(fs.readFileSync(path.join(tmpDir, "copilot-models.json"), "utf8"));

		expect(configs).toHaveLength(1);
		expect(configs[0]).toEqual({
			id: "gpt-4.1",
			name: "GPT-4.1",
			contextWindow: 128000,
			maxOutput: 16000,
			premiumRequestMultiplier: 0,
			enabled: true,
		});
	});

	test("returns correct summary counts", async () => {
		globalThis.fetch = mockFetch({
			"gpt-4.1": 200,
			"claude-sonnet-4.6": 200,
			"claude-opus-4.6": 403,
		});

		const result = await refreshModels("fake-token", TEST_BASE_URL, tmpDir);

		expect(result.total).toBe(3);
		expect(result.enabled).toBe(2);
		expect(result.configPath).toBe(path.join(tmpDir, "copilot-models.json"));
	});

	test("network error during ping is caught and model stays disabled", async () => {
		globalThis.fetch = mockFetch({
			"gpt-4.1": 200,
			"claude-sonnet-4.6": new Error("ECONNREFUSED"),
		});

		const result = await refreshModels("fake-token", TEST_BASE_URL, tmpDir);
		const configs = JSON.parse(fs.readFileSync(path.join(tmpDir, "copilot-models.json"), "utf8"));

		const gpt = configs.find((c: { id: string }) => c.id === "gpt-4.1");
		const claude = configs.find((c: { id: string }) => c.id === "claude-sonnet-4.6");
		expect(gpt.enabled).toBe(true);
		expect(claude.enabled).toBe(false);
		expect(result.enabled).toBe(1);
	});

	test("creates configDir if it does not exist", async () => {
		const nestedDir = path.join(tmpDir, "nested", "deep");
		globalThis.fetch = mockFetch({ "gpt-4.1": 200 });

		await refreshModels("fake-token", TEST_BASE_URL, nestedDir);

		expect(fs.existsSync(path.join(nestedDir, "copilot-models.json"))).toBe(true);
	});

	test("throws when catalog fetch fails", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED")));
		expect(refreshModels("token", TEST_BASE_URL, tmpDir)).rejects.toThrow("ECONNREFUSED");
	});

	test("Claude models are probed via /v1/messages with max_tokens", async () => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

			if (urlStr.includes("models.dev")) {
				return Promise.resolve(new Response(JSON.stringify(catalogResponse(["gpt-4.1", "claude-sonnet-4.6"]))));
			}

			if (urlStr.includes("/models/") && urlStr.includes("/policy")) {
				return Promise.resolve(new Response(null, { status: 200 }));
			}

			if (urlStr.includes("api.individual.githubcopilot.com")) {
				calls.push({
					url: urlStr,
					body: JSON.parse(init?.body as string),
				});
				return Promise.resolve(new Response(null, { status: 200 }));
			}

			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		});

		await refreshModels("fake-token", TEST_BASE_URL, tmpDir);

		const gptCall = calls.find((c) => c.body.model === "gpt-4.1");
		const claudeCall = calls.find((c) => c.body.model === "claude-sonnet-4.6");

		// GPT goes to chat/completions
		expect(gptCall?.url).toContain("/chat/completions");
		expect(gptCall?.url).not.toContain("/v1/messages");
		expect(gptCall?.body.max_tokens).toBeUndefined();

		// Claude goes to /v1/messages
		expect(claudeCall?.url).toContain("/v1/messages");
		expect(claudeCall?.url).not.toContain("/chat/completions");
		expect(claudeCall?.body.max_tokens).toBe(16);
	});

	test("ping requests use correct headers and body", async () => {
		const calls: { headers: Record<string, string>; body: unknown }[] = [];
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

			if (urlStr.includes("models.dev")) {
				return Promise.resolve(new Response(JSON.stringify(catalogResponse(["gpt-4.1"]))));
			}

			// enableModels policy calls
			if (urlStr.includes("/models/") && urlStr.includes("/policy")) {
				return Promise.resolve(new Response(null, { status: 200 }));
			}

			if (urlStr.includes("api.individual.githubcopilot.com")) {
				calls.push({
					headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
					body: JSON.parse(init?.body as string),
				});
				return Promise.resolve(new Response(null, { status: 200 }));
			}

			return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
		});

		await refreshModels("test-token-123", TEST_BASE_URL, tmpDir);

		expect(calls).toHaveLength(1);
		expect(calls[0].headers["x-initiator"]).toBe("agent");
		expect(calls[0].headers.Authorization).toBe("Bearer test-token-123");
		expect(calls[0].body).toEqual({
			model: "gpt-4.1",
			messages: [{ role: "user", content: "Ping. Respond pong." }],
			stream: false,
		});
	});
});
