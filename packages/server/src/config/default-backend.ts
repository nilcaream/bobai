import path from "node:path";
import { loadAuthStore } from "../auth/store";
import type { Logger } from "../log/logger";
import { buildSortedProviderModelList, providerModelsConfigExists } from "../provider/models";
import { isSupportedProvider, type ProviderId } from "../provider/providers";

export interface BackendConfigLayer {
	filePath: string;
	provider?: string | null;
	model?: string | null;
}

export interface ValidatedBackend {
	provider: ProviderId;
	model: string;
}

function logError(logger: Pick<Logger, "error"> | undefined, message: string) {
	logger?.error("CONFIG", message);
}

function validateLayer(layer: BackendConfigLayer, configDir: string, logger?: Pick<Logger, "error">): ValidatedBackend | null {
	const provider = layer.provider ?? undefined;
	const model = layer.model ?? undefined;
	const filePath = path.resolve(layer.filePath);
	if (!provider && !model) return null;
	if (!provider || !model) {
		logError(logger, `Provider/model defaults in ${filePath} are incomplete`);
		return null;
	}
	if (!isSupportedProvider(provider)) {
		logError(logger, `Provider ${provider} in ${filePath} is invalid`);
		return null;
	}
	const store = loadAuthStore(configDir);
	if (!store?.providers[provider]) {
		logError(logger, `No authentication details for provider ${provider}`);
		return null;
	}
	if (!providerModelsConfigExists(provider, configDir)) {
		logError(logger, `Provider ${provider} in ${filePath} is invalid`);
		return null;
	}
	const modelExists = buildSortedProviderModelList(provider, configDir).some((entry) => entry.id === model);
	if (!modelExists) {
		logError(logger, `Model ${model} in ${filePath} is invalid`);
		return null;
	}
	return { provider, model };
}

export function resolveValidatedDefaultBackend(
	options: {
		project: BackendConfigLayer;
		global: BackendConfigLayer;
		configDir: string;
	},
	logger?: Pick<Logger, "error">,
): ValidatedBackend | null {
	return (
		validateLayer(options.project, options.configDir, logger) ??
		validateLayer(options.global, options.configDir, logger) ??
		null
	);
}
