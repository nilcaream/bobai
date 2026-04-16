import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../src/models-catalog";
import { buildModelConfigs, CURATED_MODELS, PREMIUM_REQUEST_MULTIPLIERS } from "../src/provider/copilot-models";

describe("copilot model constants", () => {
	test("curated list has 10 models", () => {
		expect(CURATED_MODELS).toHaveLength(10);
	});

	test("every curated model has a multiplier", () => {
		for (const id of CURATED_MODELS) {
			expect(PREMIUM_REQUEST_MULTIPLIERS[id]).toBeDefined();
		}
	});
});

describe("buildModelConfigs", () => {
	test("filters catalog by curated list and attaches multiplier", () => {
		const catalog: CatalogModel[] = [
			{ id: "gpt-4.1", name: "GPT-4.1", contextWindow: 64000, maxOutput: 16384 },
			{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64000, maxOutput: 16384 },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 128000, maxOutput: 16000 },
		];

		const configs = buildModelConfigs(catalog);
		expect(configs).toHaveLength(3); // all three are in curated list
		expect(configs.find((c) => c.id === "gpt-4.1")).toEqual({
			id: "gpt-4.1",
			name: "GPT-4.1",
			contextWindow: 64000,
			maxOutput: 16384,
			premiumRequestMultiplier: 0,
			enabled: false,
		});
		expect(configs.find((c) => c.id === "gpt-4o")).toEqual({
			id: "gpt-4o",
			name: "GPT-4o",
			contextWindow: 64000,
			maxOutput: 16384,
			premiumRequestMultiplier: 0,
			enabled: false,
		});
	});

	test("models default to enabled: false before verification", () => {
		const catalog: CatalogModel[] = [
			{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 200000, maxOutput: 16000 },
		];
		const configs = buildModelConfigs(catalog);
		expect(configs[0].enabled).toBe(false);
	});

	test("returns empty array for empty catalog", () => {
		const configs = buildModelConfigs([]);
		expect(configs).toHaveLength(0);
	});
});
