import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../src/models-catalog";
import {
	buildModelConfigs,
	buildSortedModelList,
	CURATED_MODELS,
	formatModelCost,
	PREMIUM_REQUEST_MULTIPLIERS,
} from "../src/provider/copilot-models";

const EXPECTED_CURATED_MODELS = [
	"grok-code-fast-1",
	"claude-haiku-4.5",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gemini-2.5-pro",
	"gemini-3.1-pro-preview",
	"gemini-3-flash-preview",
	"claude-opus-4.5",
	"claude-opus-4.6",
	"claude-sonnet-4.5",
	"claude-sonnet-4.6",
	"gpt-5-mini",
	"gpt-5.4-mini",
] as const;

describe("copilot model constants", () => {
	test("curated list has the requested 15 models in order", () => {
		expect(CURATED_MODELS).toEqual(EXPECTED_CURATED_MODELS);
	});

	test("every curated model has a multiplier", () => {
		for (const id of CURATED_MODELS) {
			expect(PREMIUM_REQUEST_MULTIPLIERS[id]).toBeDefined();
		}
	});

	test("formatModelCost best-matches preview model ids used by Copilot", () => {
		expect(formatModelCost("gemini-3-pro-preview")).toBe("1x");
		expect(formatModelCost("gemini-3.1-pro-preview")).toBe("1x");
		expect(formatModelCost("gemini-3-flash-preview")).toBe("0.33x");
	});
});

describe("buildModelConfigs", () => {
	test("filters catalog by curated list and attaches multiplier", () => {
		const catalog: CatalogModel[] = [
			{ id: "gpt-5.2", name: "GPT-5.2", contextWindow: 264000, maxOutput: 64000 },
			{ id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview", contextWindow: 128000, maxOutput: 64000 },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 200000, maxOutput: 32000 },
		];

		const configs = buildModelConfigs(catalog);
		expect(configs).toHaveLength(2);
		expect(configs.find((c) => c.id === "gpt-5.2")).toEqual({
			id: "gpt-5.2",
			name: "GPT-5.2",
			contextWindow: 264000,
			maxOutput: 64000,
			premiumRequestMultiplier: 1,
			enabled: false,
		});
		expect(configs.find((c) => c.id === "gemini-3-pro-preview")).toBeUndefined();
	});

	test("models default to enabled: false before verification", () => {
		const catalog: CatalogModel[] = [
			{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 144000, maxOutput: 64000 },
		];
		const configs = buildModelConfigs(catalog);
		expect(configs[0].enabled).toBe(false);
	});

	test("returns empty array for empty catalog", () => {
		const configs = buildModelConfigs([]);
		expect(configs).toHaveLength(0);
	});
});

describe("buildSortedModelList", () => {
	test("returns id-sorted order with cost and context window metadata", () => {
		const models = buildSortedModelList([
			{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 144000, maxOutput: 64000 },
			{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutput: 64000 },
			{ id: "gpt-5.2", name: "GPT-5.2", contextWindow: 128000, maxOutput: 64000 },
			{ id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 264000, maxOutput: 64000 },
			{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 200000, maxOutput: 64000 },
		]);

		expect(models.findIndex((model) => model.id === "claude-opus-4.6")).toBeLessThan(
			models.findIndex((model) => model.id === "gpt-5.2"),
		);
		expect(models.findIndex((model) => model.id === "gpt-5.2")).toBeLessThan(
			models.findIndex((model) => model.id === "gpt-5.4"),
		);
		expect(models.findIndex((model) => model.id === "gpt-5-mini")).toBeLessThan(
			models.findIndex((model) => model.id === "gpt-5.2"),
		);
		expect(models.findIndex((model) => model.id === "gpt-5.4")).toBeLessThan(
			models.findIndex((model) => model.id === "gpt-5.4-mini"),
		);
		expect(models.findIndex((model) => model.id === "gpt-5.4-mini")).toBeLessThan(
			models.findIndex((model) => model.id === "grok-code-fast-1"),
		);
		expect(models.find((model) => model.id === "gpt-5-mini")).toEqual({ id: "gpt-5-mini", cost: "0x", contextWindow: 264000 });
		expect(models.find((model) => model.id === "gpt-5.4-mini")).toEqual({
			id: "gpt-5.4-mini",
			cost: "0.33x",
			contextWindow: 200000,
		});
		expect(models.find((model) => model.id === "gpt-5.4")).toEqual({ id: "gpt-5.4", cost: "1x", contextWindow: 272000 });
	});

	test("returns contextWindow 0 when catalog metadata is missing", () => {
		const models = buildSortedModelList([{ id: "gpt-5.2", name: "GPT-5.2", contextWindow: 264000, maxOutput: 64000 }]);
		const missing = models.find((model) => model.id === "gpt-5-mini");
		expect(missing).toEqual({ id: "gpt-5-mini", cost: "0x", contextWindow: 0 });
	});
});
