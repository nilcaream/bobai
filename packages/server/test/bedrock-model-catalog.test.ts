import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BedrockFoundationModelSummary } from "../src/auth/amazon-bedrock";
import { fetchBedrockFoundationModels } from "../src/auth/amazon-bedrock";
import { refreshBedrockModelsFromFoundation, regionToInferencePrefix } from "../src/provider/unified-model-catalog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** On-demand model — can be called with bare model ID */
const HAIKU_ON_DEMAND: BedrockFoundationModelSummary = {
	modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
	modelName: "Claude Haiku 4.5",
	providerName: "Anthropic",
	inputModalities: ["TEXT", "IMAGE"],
	outputModalities: ["TEXT"],
	responseStreamingSupported: true,
	inferenceTypesSupported: ["ON_DEMAND", "CROSS_REGION_INFERENCE"],
};

/** Cross-region-only model — requires prefixed inference profile ID */
const HAIKU_CROSS_REGION_ONLY: BedrockFoundationModelSummary = {
	...HAIKU_ON_DEMAND,
	inferenceTypesSupported: ["CROSS_REGION_INFERENCE"],
};

const DEEPSEEK_SUMMARY: BedrockFoundationModelSummary = {
	modelId: "deepseek.v3-v1:0",
	modelName: "DeepSeek V3",
	providerName: "DeepSeek",
	inputModalities: ["TEXT"],
	outputModalities: ["TEXT"],
	responseStreamingSupported: true,
	inferenceTypesSupported: ["ON_DEMAND"],
};

const IMAGE_ONLY_SUMMARY: BedrockFoundationModelSummary = {
	modelId: "amazon.titan-image-generator-v2:0",
	modelName: "Amazon Titan Image Generator v2",
	providerName: "Amazon",
	inputModalities: ["TEXT"],
	outputModalities: ["IMAGE"],
	responseStreamingSupported: false,
};

const MODELS_DEV_RESPONSE = {
	"amazon-bedrock": {
		id: "amazon-bedrock",
		name: "Amazon Bedrock",
		models: {
			"anthropic.claude-haiku-4-5-20251001-v1:0": {
				id: "anthropic.claude-haiku-4-5-20251001-v1:0",
				name: "Claude Haiku 4.5",
				tool_call: true,
				limit: { context: 200000, output: 16384 },
				cost: { input: 0.8, output: 4 },
			},
			"eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
				id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
				name: "Claude Haiku 4.5 (EU)",
				tool_call: true,
				limit: { context: 200000, output: 16384 },
				cost: { input: 0.8, output: 4 },
			},
			"deepseek.v3-v1:0": {
				id: "deepseek.v3-v1:0",
				name: "DeepSeek V3",
				tool_call: true,
				limit: { context: 131072, output: 8192 },
				cost: { input: 0.27, output: 1.1 },
			},
		},
	},
};

// ---------------------------------------------------------------------------
// regionToInferencePrefix
// ---------------------------------------------------------------------------

describe("regionToInferencePrefix", () => {
	test.each([
		["us-east-1", "us"],
		["us-west-2", "us"],
		["eu-north-1", "eu"],
		["eu-west-1", "eu"],
		["eu-central-1", "eu"],
		["ap-northeast-1", "ap"],
		["ap-southeast-2", "ap"],
	])("region %s maps to prefix %s", (region, expected) => {
		expect(regionToInferencePrefix(region)).toBe(expected);
	});

	test("returns undefined for regions without a standard cross-region prefix", () => {
		expect(regionToInferencePrefix("sa-east-1")).toBeUndefined();
		expect(regionToInferencePrefix("me-south-1")).toBeUndefined();
		expect(regionToInferencePrefix("ca-central-1")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// fetchBedrockFoundationModels
// ---------------------------------------------------------------------------

describe("fetchBedrockFoundationModels", () => {
	test("returns parsed model summaries on success", async () => {
		const models = await fetchBedrockFoundationModels("key", "eu-north-1", {
			fetch: async () =>
				new Response(
					JSON.stringify({
						modelSummaries: [HAIKU_ON_DEMAND, DEEPSEEK_SUMMARY],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		expect(models).toHaveLength(2);
		expect(models[0].modelId).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(models[1].modelId).toBe("deepseek.v3-v1:0");
	});

	test("returns empty array when modelSummaries is missing", async () => {
		const models = await fetchBedrockFoundationModels("key", "us-east-1", {
			fetch: async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
		});
		expect(models).toEqual([]);
	});

	test("throws on non-OK HTTP status", async () => {
		await expect(
			fetchBedrockFoundationModels("bad", "us-east-1", {
				fetch: async () => new Response("Unauthorized", { status: 401 }),
			}),
		).rejects.toThrow(/401|Unauthorized/);
	});
});

// ---------------------------------------------------------------------------
// refreshBedrockModelsFromFoundation
// ---------------------------------------------------------------------------

describe("refreshBedrockModelsFromFoundation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-catalog-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function mockModelsDevFetch() {
		return async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr.includes("models.dev")) {
				return new Response(JSON.stringify(MODELS_DEV_RESPONSE), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		};
	}

	test("creates models.json with enriched Bedrock models", async () => {
		const result = await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND, DEEPSEEK_SUMMARY], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		expect(result.modelCount).toBe(2);
		expect(fs.existsSync(path.join(tmpDir, "models.json"))).toBe(true);

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const bedrockModels = written.providers["amazon-bedrock"] as Array<{
			id: string;
			contextWindow: number;
			inputPrice: number;
		}>;
		expect(bedrockModels).toHaveLength(2);

		// Haiku supports ON_DEMAND — stored with bare model ID
		const haiku = bedrockModels.find((m) => m.id === "anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(haiku).toMatchObject({ contextWindow: 200000, inputPrice: 0.8 });

		// DeepSeek — enriched from models.dev
		const deepseek = bedrockModels.find((m) => m.id === "deepseek.v3-v1:0");
		expect(deepseek).toMatchObject({ contextWindow: 131072, inputPrice: 0.27 });
	});

	test("stores prefixed ID for models that only support CROSS_REGION_INFERENCE (eu region)", async () => {
		const result = await refreshBedrockModelsFromFoundation([HAIKU_CROSS_REGION_ONLY], "eu-north-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		expect(result.modelCount).toBe(1);
		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		// Must use eu. prefix so the Converse API can invoke it
		expect(ids).toContain("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(ids).not.toContain("anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("stores prefixed ID for models that only support CROSS_REGION_INFERENCE (us region)", async () => {
		await refreshBedrockModelsFromFoundation([HAIKU_CROSS_REGION_ONLY], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		expect(ids).toContain("us.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("stores bare ID for models that support ON_DEMAND even in eu region", async () => {
		await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND], "eu-north-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		expect(ids).toContain("anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(ids).not.toContain("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("treats missing inferenceTypesSupported as ON_DEMAND (safe default)", async () => {
		const noInferenceInfo: BedrockFoundationModelSummary = {
			...HAIKU_ON_DEMAND,
			inferenceTypesSupported: undefined,
		};
		await refreshBedrockModelsFromFoundation([noInferenceInfo], "eu-north-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		expect(ids).toContain("anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("falls back to bare model ID lookup in models.dev when prefixed entry is absent", async () => {
		// DEEPSEEK has no prefixed entry in MODELS_DEV_RESPONSE, but the bare ID also isn't there.
		// Create a response that has the bare ID for a cross-region-only model.
		const modelsDevWithBareId = {
			"amazon-bedrock": {
				id: "amazon-bedrock",
				name: "Amazon Bedrock",
				models: {
					"deepseek.v3-v1:0": {
						id: "deepseek.v3-v1:0",
						name: "DeepSeek V3",
						tool_call: true,
						limit: { context: 131072, output: 8192 },
						cost: { input: 0.27, output: 1.1 },
					},
				},
			},
		};
		const crossRegionDeepSeek: BedrockFoundationModelSummary = {
			...DEEPSEEK_SUMMARY,
			inferenceTypesSupported: ["CROSS_REGION_INFERENCE"],
		};
		await refreshBedrockModelsFromFoundation([crossRegionDeepSeek], "eu-north-1", tmpDir, {
			fetch: async (url) => {
				if (String(url).includes("models.dev")) {
					return new Response(JSON.stringify(modelsDevWithBareId), { status: 200 });
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const model = written.providers["amazon-bedrock"][0];
		// ID should be prefixed
		expect(model.id).toBe("eu.deepseek.v3-v1:0");
		// Metadata should come from bare ID fallback lookup
		expect(model.contextWindow).toBe(131072);
		expect(model.inputPrice).toBe(0.27);
	});

	test("excludes models that do not output TEXT (e.g. image generators)", async () => {
		const result = await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND, IMAGE_ONLY_SUMMARY], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		expect(result.modelCount).toBe(1);
		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		expect(ids).not.toContain("amazon.titan-image-generator-v2:0");
	});

	test("excludes models with responseStreamingSupported === false", async () => {
		const nonStreaming: BedrockFoundationModelSummary = {
			...HAIKU_ON_DEMAND,
			modelId: "some.model-no-stream",
			responseStreamingSupported: false,
		};
		const result = await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND, nonStreaming], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		expect(result.modelCount).toBe(1);
	});

	test("reports skippedModelCount for models absent from models.dev", async () => {
		const unknownModel: BedrockFoundationModelSummary = {
			...HAIKU_ON_DEMAND,
			modelId: "unknown.some-new-model",
		};
		const result = await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND, unknownModel], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});
		expect(result.modelCount).toBe(1); // only Haiku included
		expect(result.skippedModelCount).toBe(1); // unknown model skipped
	});

	test("preserves other provider sections when models.json already exists", async () => {
		// Pre-populate with some copilot models
		const existing = {
			version: 1,
			generatedAt: "2026-01-01T00:00:00.000Z",
			providers: {
				"github-copilot": [
					{ id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 264000, maxOutput: 64000, inputPrice: 0, outputPrice: 0 },
				],
				openrouter: [],
				"opencode-go": [],
				"opencode-zen": [],
				"amazon-bedrock": [],
			},
		};
		fs.writeFileSync(path.join(tmpDir, "models.json"), JSON.stringify(existing));

		await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		// Copilot section intact
		expect(written.providers["github-copilot"]).toHaveLength(1);
		expect(written.providers["github-copilot"][0].id).toBe("gpt-5-mini");
		// Bedrock section updated
		expect(written.providers["amazon-bedrock"]).toHaveLength(1);
	});

	test("models are sorted alphabetically by ID", async () => {
		const result = await refreshBedrockModelsFromFoundation([DEEPSEEK_SUMMARY, HAIKU_ON_DEMAND], "us-east-1", tmpDir, {
			fetch: mockModelsDevFetch() as typeof fetch,
		});

		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		const ids = written.providers["amazon-bedrock"].map((m: { id: string }) => m.id);
		expect(ids).toEqual([...ids].sort());
		expect(result.modelCount).toBe(2); // both in models.dev fixture
	});

	test("skips all models when models.dev is unreachable (no metadata to resolve maxTokens)", async () => {
		const result = await refreshBedrockModelsFromFoundation([HAIKU_ON_DEMAND], "us-east-1", tmpDir, {
			fetch: async () => new Response("Service unavailable", { status: 503 }) as Response,
		});

		// Without models.dev, contextWindow and maxOutput are 0 → all models excluded
		expect(result.modelCount).toBe(0);
		expect(result.skippedModelCount).toBe(1);
		const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf8"));
		expect(written.providers["amazon-bedrock"]).toHaveLength(0);
	});
});
