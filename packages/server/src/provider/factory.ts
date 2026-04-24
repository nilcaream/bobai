import { authorizeCopilot as defaultAuthorizeCopilot } from "../auth/authorize";
import {
	type AuthStore,
	type CopilotAuth,
	loadAuthStore as defaultLoadAuthStore,
	type OpenCodeGoAuth,
	type OpenRouterAuth,
} from "../auth/store";
import type { Logger } from "../log/logger";
import { createCopilotProvider as defaultCreateCopilotProvider } from "./copilot";
import { providerModelsConfigExists as defaultProviderModelsConfigExists } from "./models";
import { createOpenCodeGoProvider as defaultCreateOpenCodeGoProvider } from "./opencode-go";
import { createOpenRouterProvider as defaultCreateOpenRouterProvider } from "./openrouter";
import type { Provider } from "./provider";
import type { ProviderId } from "./providers";
import { getProviderDescriptor } from "./registry";

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
	createOpenRouterProvider?: (auth: OpenRouterAuth, logger?: Logger) => Provider;
	createOpenCodeGoProvider?: (auth: OpenCodeGoAuth, logger?: Logger) => Provider;
}

export async function createConfiguredProvider(
	options: CreateProviderOptions,
	deps: CreateProviderDeps = {},
): Promise<Provider> {
	const providerModelsConfigExists = deps.providerModelsConfigExists ?? defaultProviderModelsConfigExists;
	const loadAuthStore = deps.loadAuthStore ?? defaultLoadAuthStore;
	const descriptor = getProviderDescriptor(options.providerId);
	if (!descriptor) {
		throw new Error(`Unsupported provider: ${options.providerId}`);
	}

	if (!providerModelsConfigExists(options.providerId, options.configDir)) {
		throw new Error("Model configuration not found. Please run: bobai refresh");
	}

	return descriptor.createConfiguredProvider({
		configDir: options.configDir,
		logger: options.logger,
		store: loadAuthStore(options.configDir),
		authorizeCopilot: deps.authorizeCopilot ?? defaultAuthorizeCopilot,
		createCopilotProvider: deps.createCopilotProvider ?? defaultCreateCopilotProvider,
		createOpenRouterProvider: deps.createOpenRouterProvider ?? defaultCreateOpenRouterProvider,
		createOpenCodeGoProvider: deps.createOpenCodeGoProvider ?? defaultCreateOpenCodeGoProvider,
	});
}
