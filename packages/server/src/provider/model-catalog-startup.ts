import type { Logger } from "../log/logger";

export async function ensureModelCatalogAvailable(options: {
	catalogExists: () => boolean;
	refreshCatalog: () => Promise<void>;
	logger?: Pick<Logger, "error">;
}): Promise<void> {
	if (options.catalogExists()) {
		return;
	}

	try {
		await options.refreshCatalog();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.catalogExists()) {
			options.logger?.error("MODEL", `Model catalog refresh failed: ${message}. Using existing stale model catalog.`);
			return;
		}
		options.logger?.error("MODEL", `Model catalog refresh failed: ${message}`);
		throw error;
	}
}
