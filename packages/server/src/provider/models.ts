import {
	buildSortedModelList,
	formatModelDisplay,
	loadModelsConfig,
	modelsConfigExists,
	type SortedModelListItem,
} from "./copilot-models";
import type { ProviderId } from "./providers";

export interface ProviderModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
}

export type SortedProviderModelListItem = SortedModelListItem;

export function providerModelsConfigExists(providerId: ProviderId, configDir?: string): boolean {
	switch (providerId) {
		case "github-copilot":
			return modelsConfigExists(configDir);
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}

export function loadProviderModelsConfig(providerId: ProviderId, configDir?: string): ProviderModelConfig[] {
	switch (providerId) {
		case "github-copilot":
			return loadModelsConfig(configDir);
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
			return formatModelDisplay(modelId, promptTokens, configDir);
		default:
			throw new Error(`Unsupported provider: ${providerId}`);
	}
}
