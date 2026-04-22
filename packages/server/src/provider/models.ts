import {
	buildSortedModelList,
	formatModelDisplay,
	loadModelsConfig,
	modelsConfigExists,
	type SortedModelListItem,
} from "./copilot-models";
import { loadOpenRouterModelsConfig } from "./openrouter-models";
import type { ProviderId } from "./providers";

export interface ProviderModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	label?: string;
	inputPrice?: number;
	outputPrice?: number;
}

export type SortedProviderModelListItem = SortedModelListItem;

function formatGenericProviderModelDisplay(
	providerId: ProviderId,
	modelConfig: ProviderModelConfig | undefined,
	promptTokens: number,
): string {
	const label = modelConfig?.label ? ` | ${modelConfig.label}` : "";
	const contextWindow = modelConfig?.contextWindow ?? 0;
	const percent = contextWindow > 0 ? Math.round((promptTokens / contextWindow) * 100) : 0;
	return `${providerId} | ${modelConfig?.id ?? "unknown-model"}${label} | ${promptTokens} / ${contextWindow} | ${percent}%`;
}

export function providerModelsConfigExists(providerId: ProviderId, configDir?: string): boolean {
	switch (providerId) {
		case "github-copilot":
			return modelsConfigExists(configDir);
		case "openrouter":
			return true;
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}

export function loadProviderModelsConfig(providerId: ProviderId, configDir?: string): ProviderModelConfig[] {
	switch (providerId) {
		case "github-copilot":
			return loadModelsConfig(configDir);
		case "openrouter":
			return loadOpenRouterModelsConfig();
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}

export function getProviderModelConfig(
	providerId: ProviderId,
	modelId: string,
	configDir?: string,
): ProviderModelConfig | undefined {
	return loadProviderModelsConfig(providerId, configDir).find((model) => model.id === modelId);
}

export function buildSortedProviderModelList(providerId: ProviderId, configDir?: string): SortedProviderModelListItem[] {
	switch (providerId) {
		case "github-copilot":
			return buildSortedModelList(loadModelsConfig(configDir));
		case "openrouter":
			return loadOpenRouterModelsConfig()
				.map((model) => ({ id: model.id, cost: model.label, contextWindow: model.contextWindow }))
				.sort((a, b) => a.id.localeCompare(b.id));
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}

export function formatProviderModelDisplay(
	providerId: ProviderId,
	modelId: string,
	promptTokens: number,
	configDir?: string,
): string {
	switch (providerId) {
		case "github-copilot":
			return `${providerId} | ${formatModelDisplay(modelId, promptTokens, configDir)}`;
		case "openrouter":
			return formatGenericProviderModelDisplay(
				providerId,
				getProviderModelConfig(providerId, modelId, configDir),
				promptTokens,
			);
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}
