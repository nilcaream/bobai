import type { Logger } from "../log/logger";
import { createConfiguredProvider } from "./factory";
import type { Provider } from "./provider";
import type { ProviderId } from "./providers";

export interface ProviderRuntimeManager {
	get(providerId: ProviderId): Promise<Provider>;
}

export interface CreateProviderRuntimeManagerOptions {
	configDir: string;
	logger?: Logger;
	fetch?: typeof fetch;
}

export interface CreateProviderRuntimeManagerDeps {
	createProvider?: (providerId: ProviderId) => Promise<Provider>;
}

export function createProviderRuntimeManager(
	options: CreateProviderRuntimeManagerOptions,
	deps: CreateProviderRuntimeManagerDeps = {},
): ProviderRuntimeManager {
	const cache = new Map<ProviderId, Promise<Provider>>();
	const createProvider =
		deps.createProvider ??
		((providerId: ProviderId) =>
			createConfiguredProvider({
				providerId,
				configDir: options.configDir,
				logger: options.logger,
				fetch: options.fetch,
			}));

	return {
		get(providerId: ProviderId): Promise<Provider> {
			const cached = cache.get(providerId);
			if (cached) return cached;
			const created = createProvider(providerId);
			cache.set(providerId, created);
			return created;
		},
	};
}
