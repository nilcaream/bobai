import { authorizeCopilot as defaultAuthorizeCopilot } from "../auth/authorize";
import { type AuthStore, type CopilotAuth, loadAuthStore as defaultLoadAuthStore, getCopilotAuth } from "../auth/store";
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
	loadAuthStore?: (configDir: string) => AuthStore | undefined;
	authorizeCopilot?: (configDir: string) => Promise<CopilotAuth>;
	createCopilotProvider?: (auth: CopilotAuth, configDir?: string, logger?: Logger) => Provider;
}

export async function createConfiguredProvider(
	options: CreateProviderOptions,
	deps: CreateProviderDeps = {},
): Promise<Provider> {
	const providerModelsConfigExists = deps.providerModelsConfigExists ?? defaultProviderModelsConfigExists;
	const loadAuthStore = deps.loadAuthStore ?? defaultLoadAuthStore;
	const authorizeCopilot = deps.authorizeCopilot ?? defaultAuthorizeCopilot;
	const createCopilotProvider = deps.createCopilotProvider ?? defaultCreateCopilotProvider;

	switch (options.providerId) {
		case "github-copilot": {
			if (!providerModelsConfigExists(options.providerId, options.configDir)) {
				throw new Error("Model configuration not found. Please run: bobai refresh");
			}
			const store = loadAuthStore(options.configDir);
			let auth = store ? getCopilotAuth(store) : undefined;
			if (!auth) {
				auth = await authorizeCopilot(options.configDir);
			}
			return createCopilotProvider(auth, options.configDir, options.logger);
		}
		default:
			throw new Error(`Unsupported provider: ${options.providerId}`);
	}
}
