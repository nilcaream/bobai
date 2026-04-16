import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CatalogModel } from "../models-catalog";

export interface ModelConfig extends CatalogModel {
	premiumRequestMultiplier: number;
	enabled: boolean;
}

export const CURATED_MODELS = [
	"gpt-4o",
	"gpt-4.1",
	"gpt-5-mini",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"grok-code-fast-1",
	"claude-haiku-4.5",
	"claude-sonnet-4.6",
	"claude-opus-4.6",
] as const;

type CuratedModelId = (typeof CURATED_MODELS)[number];

export const PREMIUM_REQUEST_MULTIPLIERS: Record<CuratedModelId, number> = {
	"gpt-4o": 0,
	"gpt-4.1": 0,
	"gpt-5-mini": 0,
	"gpt-5.3-codex": 1,
	"gpt-5.4": 1,
	"gpt-5.4-mini": 0.33,
	"grok-code-fast-1": 0.25,
	"claude-haiku-4.5": 0.33,
	"claude-sonnet-4.6": 1,
	"claude-opus-4.6": 3,
};

/** Format the cost label for a model (e.g. "0x", "1x", "3x"). */
export function formatModelCost(modelId: string): string {
	const multiplier = PREMIUM_REQUEST_MULTIPLIERS[modelId as CuratedModelId];
	return multiplier !== undefined ? `${multiplier}x` : "?x";
}

/** Format the status prefix for a model (e.g. "gpt-5-mini | 0x"). */
function formatModelStatus(modelId: string): string {
	return `${modelId} | ${formatModelCost(modelId)}`;
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
	const statusPrefix = formatModelStatus(modelId);
	const configs = loadModelsConfig(configDir);
	const modelConfig = configs.find((m) => m.id === modelId);
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
	return `${statusPrefix} | ${promptTokens} tokens`;
}

export function buildModelConfigs(catalog: CatalogModel[]): ModelConfig[] {
	const catalogMap = new Map(catalog.map((m) => [m.id, m]));
	const configs: ModelConfig[] = [];
	for (const id of CURATED_MODELS) {
		const m = catalogMap.get(id);
		if (m) {
			configs.push({
				...m,
				premiumRequestMultiplier: PREMIUM_REQUEST_MULTIPLIERS[id] ?? 1,
				enabled: false,
			});
		}
	}
	return configs;
}
