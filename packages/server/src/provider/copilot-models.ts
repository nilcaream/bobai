import type { CatalogModel } from "../models-catalog";

export interface ModelConfig extends CatalogModel {
	premiumRequestMultiplier: number;
	enabled: boolean;
}

export const CURATED_MODELS = [
	"gpt-4o",
	"gpt-4.1",
	"gpt-5-mini",
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
export function formatModelStatus(modelId: string): string {
	return `${modelId} | ${formatModelCost(modelId)}`;
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
