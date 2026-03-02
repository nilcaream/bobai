import type { CatalogModel } from "../models-catalog";

export interface ModelConfig extends CatalogModel {
	premiumRequestMultiplier: number;
	enabled: boolean;
}

export const CURATED_MODELS = [
	"gpt-4.1",
	"gpt-5-mini",
	"grok-code-fast-1",
	"claude-haiku-4.5",
	"claude-sonnet-4.6",
	"claude-opus-4.6",
] as const;

type CuratedModelId = (typeof CURATED_MODELS)[number];

export const PREMIUM_REQUEST_MULTIPLIERS: Record<CuratedModelId, number> = {
	"gpt-4.1": 0,
	"gpt-5-mini": 0,
	"grok-code-fast-1": 0.25,
	"claude-haiku-4.5": 0.33,
	"claude-sonnet-4.6": 1,
	"claude-opus-4.6": 3,
};

export function buildModelConfigs(catalog: CatalogModel[]): ModelConfig[] {
	const curatedSet = new Set<string>(CURATED_MODELS);
	return catalog
		.filter((m) => curatedSet.has(m.id))
		.map((m) => ({
			...m,
			premiumRequestMultiplier: PREMIUM_REQUEST_MULTIPLIERS[m.id as CuratedModelId] ?? 1,
			enabled: false,
		}));
}
