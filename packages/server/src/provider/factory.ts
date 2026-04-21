import { authorize as defaultAuthorize } from "../auth/authorize";
import { loadAuth as defaultLoadAuth, type StoredAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { createCopilotProvider as defaultCreateCopilotProvider } from "./copilot";
import { providerModelsConfigExists as defaultProviderModelsConfigExists } from "./models";
import type { Provider } from "./provider";
import type { ProviderId } from "./providers";

export interface CreateProviderOptions {
	providerId: ProviderId;
	configDir: string;
	logger?: Logger;
}

export interface CreateProviderDeps {
	providerModelsConfigExists?: (providerId: ProviderId, configDir?: string) => boolean;
	loadAuth?: (configDir: string) => StoredAuth | undefined;
	authorize?: (configDir: string) => Promise<StoredAuth>;
	createCopilotProvider?: (auth: StoredAuth, configDir?: string, logger?: Logger) => Provider;
}

export async function createConfiguredProvider(
	options: CreateProviderOptions,
	deps: CreateProviderDeps = {},
): Promise<Provider> {
	const providerModelsConfigExists = deps.providerModelsConfigExists ?? defaultProviderModelsConfigExists;
	const loadAuth = deps.loadAuth ?? defaultLoadAuth;
	const authorize = deps.authorize ?? defaultAuthorize;
	const createCopilotProvider = deps.createCopilotProvider ?? defaultCreateCopilotProvider;

	switch (options.providerId) {
		case "github-copilot": {
			if (!providerModelsConfigExists(options.providerId, options.configDir)) {
				throw new Error("Model configuration not found. Please run: bobai refresh");
			}
			let auth = loadAuth(options.configDir);
			if (!auth) {
				auth = await authorize(options.configDir);
			}
			return createCopilotProvider(auth, options.configDir, options.logger);
		}
		default:
			throw new Error(`Unsupported provider: ${options.providerId}`);
	}
}
