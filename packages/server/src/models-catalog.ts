const MODELS_DEV_URL = "https://models.dev/api.json";

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
}

interface ModelsDevModel {
	id: string;
	name: string;
	limit: { context: number; output: number };
}

interface ModelsDevProvider {
	id: string;
	name: string;
	models: Record<string, ModelsDevModel>;
}

export async function fetchCatalog(providerId: string): Promise<CatalogModel[]> {
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`models.dev returned HTTP ${response.status}`);
	}
	const data = (await response.json()) as Record<string, ModelsDevProvider>;
	const provider = data[providerId];
	if (!provider) return [];

	return Object.values(provider.models).map((m) => ({
		id: m.id,
		name: m.name,
		contextWindow: m.limit.context,
		maxOutput: m.limit.output,
	}));
}
