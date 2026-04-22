import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CatalogModel } from "../models-catalog";

export interface ModelConfig extends CatalogModel {
	premiumRequestMultiplier: number;
	label?: string;
	enabled: boolean;
}

export const CURATED_MODELS = [
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

type CuratedModelId = (typeof CURATED_MODELS)[number];

type PricedModelId = CuratedModelId | "gemini-3-pro" | "gemini-3.1-pro" | "gemini-3-flash" | "gpt-4.1" | "gpt-4o";

export const PREMIUM_REQUEST_MULTIPLIERS: Record<PricedModelId, number> = {
	"grok-code-fast-1": 0.25,
	"claude-haiku-4.5": 0.33,
	"gpt-5.2": 1,
	"gpt-5.2-codex": 1,
	"gpt-5.3-codex": 1,
	"gpt-5.4": 1,
	"gemini-2.5-pro": 1,
	"gemini-3-pro-preview": 1,
	"gemini-3.1-pro-preview": 1,
	"gemini-3-flash-preview": 0.33,
	"claude-opus-4.5": 3,
	"claude-opus-4.6": 3,
	"claude-sonnet-4.5": 1,
	"claude-sonnet-4.6": 1,
	"gpt-5-mini": 0,
	"gpt-5.4-mini": 0.33,
	"gemini-3-pro": 1,
	"gemini-3.1-pro": 1,
	"gemini-3-flash": 0.33,
	"gpt-4.1": 0,
	"gpt-4o": 0,
};

function normalizePricingModelId(modelId: string): PricedModelId | null {
	if (modelId in PREMIUM_REQUEST_MULTIPLIERS) {
		return modelId as PricedModelId;
	}

	const withoutPreview = modelId.replace(/-preview$/, "");
	if (withoutPreview in PREMIUM_REQUEST_MULTIPLIERS) {
		return withoutPreview as PricedModelId;
	}

	return null;
}

export function getPremiumRequestMultiplier(modelId: string): number | undefined {
	const normalized = normalizePricingModelId(modelId);
	return normalized ? PREMIUM_REQUEST_MULTIPLIERS[normalized] : undefined;
}

/** Format the default display label for a model (e.g. "0x", "1x", "3x"). */
export function formatModelLabel(modelId: string): string {
	const multiplier = getPremiumRequestMultiplier(modelId);
	return multiplier !== undefined ? `${multiplier}x` : "?x";
}

export const formatModelCost = formatModelLabel;

function getModelLabel(modelConfig: Pick<ModelConfig, "id" | "label"> | undefined, modelId: string): string {
	return modelConfig?.label ?? formatModelLabel(modelId);
}

/** Format the status prefix for a model (e.g. "gpt-5-mini | 0x"). */
function formatModelStatus(modelId: string, modelConfig?: Pick<ModelConfig, "id" | "label">): string {
	return `${modelId} | ${getModelLabel(modelConfig, modelId)}`;
}

/** Check whether the copilot-models.json config file exists. */
export function modelsConfigExists(configDir?: string): boolean {
	const dir = configDir ?? path.join(os.homedir(), ".config", "bobai");
	return fs.existsSync(path.join(dir, "copilot-models.json"));
}

/** Load model configs from the copilot-models.json config file. */
export function loadModelsConfig(configDir?: string): ModelConfig[] {
	const dir = configDir ?? path.join(os.homedir(), ".config", "bobai");
	const filePath = path.join(dir, "copilot-models.json");
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as ModelConfig[];
	} catch (err) {
		console.warn(`[WARN] Failed to load model config from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/** Format the full display string for a model (e.g. "gpt-5-mini | 0x | 1547 / 128000 | 1%"). */
export function formatModelDisplay(modelId: string, promptTokens: number, configDir?: string): string {
	const configs = loadModelsConfig(configDir);
	const modelConfig = configs.find((m) => m.id === modelId);
	const statusPrefix = formatModelStatus(modelId, modelConfig);
	const contextWindow = modelConfig?.contextWindow ?? 0;
	if (contextWindow > 0) {
		const percent = Math.round((promptTokens / contextWindow) * 100);
		return `${statusPrefix} | ${promptTokens} / ${contextWindow} | ${percent}%`;
	}
	if (!modelConfig) {
		console.warn(`[WARN] Model "${modelId}" not found in models config; status bar will lack context window info`);
	} else {
		console.warn(`[WARN] Model "${modelId}" has no contextWindow configured; status bar will lack context window info`);
	}
	return `${statusPrefix} | ${promptTokens} / ${contextWindow} | 0%`;
}

export function buildModelConfigs(catalog: CatalogModel[]): ModelConfig[] {
	const catalogMap = new Map(catalog.map((m) => [m.id, m]));
	const configs: ModelConfig[] = [];
	for (const id of CURATED_MODELS) {
		const m = catalogMap.get(id);
		if (m) {
			configs.push({
				...m,
				premiumRequestMultiplier: getPremiumRequestMultiplier(id) ?? 1,
				label: formatModelLabel(id),
				enabled: false,
			});
		}
	}
	return configs;
}

export type SortedModelListItem = {
	id: string;
	cost: string;
	contextWindow: number;
};

export function buildSortedModelList(catalog: ModelConfig[] = loadModelsConfig()): SortedModelListItem[] {
	const catalogMap = new Map(catalog.map((model) => [model.id, model]));
	return [...CURATED_MODELS]
		.map((id) => {
			const modelConfig = catalogMap.get(id);
			return {
				id,
				cost: getModelLabel(modelConfig, id),
				contextWindow: modelConfig?.contextWindow ?? 0,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(({ id, cost, contextWindow }) => ({ id, cost, contextWindow }));
}
