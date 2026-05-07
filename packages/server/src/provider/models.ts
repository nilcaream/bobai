import type { ProviderId } from "./providers";
import { getProviderDescriptor, type ProviderModelConfig, type SortedProviderModelListItem } from "./registry";

function getDescriptor(providerId: ProviderId) {
	const descriptor = getProviderDescriptor(providerId);
	if (!descriptor) {
		throw new Error(`Unsupported provider: ${providerId}`);
	}
	return descriptor;
}

export type { ProviderModelConfig, SortedProviderModelListItem };

export function providerModelsConfigExists(providerId: ProviderId, configDir?: string): boolean {
	return getDescriptor(providerId).modelsConfigExists(configDir);
}

export function loadProviderModelsConfig(providerId: ProviderId, configDir?: string): ProviderModelConfig[] {
	return getDescriptor(providerId).loadModels(configDir);
}

export function getProviderModelConfig(
	providerId: ProviderId,
	modelId: string,
	configDir?: string,
): ProviderModelConfig | undefined {
	return loadProviderModelsConfig(providerId, configDir).find((model) => model.id === modelId);
}

export function buildSortedProviderModelList(providerId: ProviderId, configDir?: string): SortedProviderModelListItem[] {
	return getDescriptor(providerId).buildSortedModels(configDir);
}

export function formatProviderModelDisplay(
	providerId: ProviderId,
	modelId: string,
	promptTokens: number,
	configDir?: string,
	contextLimit?: number | null,
): string {
	return getDescriptor(providerId).formatModelDisplay(modelId, promptTokens, configDir, contextLimit);
}
