import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchCatalog } from "../src/models-catalog";

describe("fetchCatalog", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("extracts models for a known provider", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						"github-copilot": {
							id: "github-copilot",
							name: "GitHub Copilot",
							models: {
								"gpt-4o": {
									id: "gpt-4o",
									name: "GPT-4o",
									limit: { context: 64000, output: 16384 },
								},
								"claude-sonnet-4.6": {
									id: "claude-sonnet-4.6",
									name: "Claude Sonnet 4.6",
									limit: { context: 128000, output: 16000 },
								},
							},
						},
					}),
				),
			),
		);

		const models = await fetchCatalog("github-copilot");
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			id: "gpt-4o",
			name: "GPT-4o",
			contextWindow: 64000,
			maxOutput: 16384,
		});
	});

	test("returns empty array for unknown provider", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({}))));

		const models = await fetchCatalog("nonexistent");
		expect(models).toEqual([]);
	});

	test("throws on non-OK HTTP response", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 500 })));
		expect(fetchCatalog("github-copilot")).rejects.toThrow("models.dev returned HTTP 500");
	});

	test("throws on network error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network error")));
		expect(fetchCatalog("github-copilot")).rejects.toThrow("network error");
	});
});
