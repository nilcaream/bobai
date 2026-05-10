const MODELS_DEV_URL = "https://models.dev/api.json";

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
}

export interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
	id: string;
	name: string;
	models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export async function fetchModelsDevCatalog(fetchFn: typeof fetch = fetch): Promise<ModelsDevCatalog> {
	const response = await fetchFn(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`models.dev returned HTTP ${response.status}`);
	}
	return (await response.json()) as ModelsDevCatalog;
}

export async function fetchCatalog(providerId: string): Promise<CatalogModel[]> {
	const data = await fetchModelsDevCatalog();
	const provider = data[providerId];
	if (!provider) return [];

	return Object.values(provider.models).map((m) => ({
		id: m.id,
		name: m.name,
		contextWindow: m.limit?.context ?? 0,
		maxOutput: m.limit?.output ?? 0,
	}));
}
