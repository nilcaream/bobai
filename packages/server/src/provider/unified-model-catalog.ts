import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BedrockFoundationModelSummary } from "../auth/amazon-bedrock";
import { fetchBedrockFoundationModels } from "../auth/amazon-bedrock";
import { fetchModelsDevCatalog, type ModelsDevCatalog, type ModelsDevModel } from "../models-catalog";
import type { ProviderId } from "./providers";

export interface UnifiedProviderModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice?: number;
	cacheWritePrice?: number;
	supportsCaching?: boolean;
	premiumRequestMultiplier?: number;
}

export interface UnifiedModelsFile {
	version: 1;
	generatedAt: string;
	providers: Record<ProviderId, UnifiedProviderModel[]>;
}

export interface UnifiedModelCatalogRefreshResult {
	configPath: string;
	providerCount: number;
	modelCount: number;
	multiplierSourceAvailable: boolean;
}

const MODELS_FILE_NAME = "models.json";

const PROVIDER_SOURCE_MAP: Record<ProviderId, string> = {
	openrouter: "openrouter",
	"opencode-go": "opencode-go",
	"opencode-zen": "opencode",
	"amazon-bedrock": "amazon-bedrock",
	deepseek: "deepseek",
};

function defaultConfigDir(): string {
	return path.join(os.homedir(), ".config", "bobai");
}

export function getUnifiedModelsFilePath(configDir?: string): string {
	return path.join(configDir ?? defaultConfigDir(), MODELS_FILE_NAME);
}

export function unifiedModelsConfigExists(configDir?: string): boolean {
	return fs.existsSync(getUnifiedModelsFilePath(configDir));
}

export function loadUnifiedModelsFile(configDir?: string): UnifiedModelsFile {
	const filePath = getUnifiedModelsFilePath(configDir);
	const raw = fs.readFileSync(filePath, "utf8");
	return JSON.parse(raw) as UnifiedModelsFile;
}

function hasStrictMetadata(model: ModelsDevModel): model is ModelsDevModel & {
	limit: { context: number; output: number };
	cost: { input: number; output: number };
} {
	return (
		model.tool_call === true &&
		typeof model.limit?.context === "number" &&
		typeof model.limit?.output === "number" &&
		typeof model.cost?.input === "number" &&
		typeof model.cost?.output === "number"
	);
}

function normalizeProviderModels(providerId: ProviderId, catalog: ModelsDevCatalog): UnifiedProviderModel[] {
	const sourceId = PROVIDER_SOURCE_MAP[providerId];
	const source = catalog[sourceId];
	if (!source) return [];
	return Object.values(source.models)
		.filter(hasStrictMetadata)
		.map((model) => {
			const base: UnifiedProviderModel = {
				id: model.id,
				name: model.name,
				contextWindow: model.limit.context,
				maxOutput: model.limit.output,
				inputPrice: model.cost.input,
				outputPrice: model.cost.output,
			};
			if (typeof model.cost.cache_read === "number") {
				base.cacheReadPrice = model.cost.cache_read;
			}
			if (typeof model.cost.cache_write === "number") {
				base.cacheWritePrice = model.cost.cache_write;
			}
			// supportsCaching is a capability flag derived from models.dev cache costs.
			if (typeof model.cost.cache_read === "number" || typeof model.cost.cache_write === "number") {
				base.supportsCaching = true;
			}
			return base;
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

export async function refreshUnifiedModelCatalog(
	configDir?: string,
	deps: { fetch?: typeof fetch; bedrockAuth?: { apiKey: string; region: string } } = {},
): Promise<UnifiedModelCatalogRefreshResult> {
	const resolvedConfigDir = configDir ?? defaultConfigDir();
	const fetchFn = deps.fetch ?? fetch;
	const catalog = await fetchModelsDevCatalog(fetchFn);

	// Use live Bedrock foundation-models data if auth is available, so refresh
	// preserves the region-specific callable IDs written during `bobai auth amazon-bedrock`.
	// Fall back to the models.dev Bedrock data if auth is absent or the request fails.
	let bedrockModels: UnifiedProviderModel[];
	if (deps.bedrockAuth) {
		try {
			const foundationModels = await fetchBedrockFoundationModels(deps.bedrockAuth.apiKey, deps.bedrockAuth.region, {
				fetch: fetchFn,
			});
			const modelsDevById = buildModelsDevIndex(catalog);
			bedrockModels = buildBedrockModels(foundationModels, deps.bedrockAuth.region, modelsDevById);
		} catch {
			// Auth present but request failed (expired token, network issue, etc.) —
			// fall back to models.dev so refresh still completes.
			bedrockModels = normalizeProviderModels("amazon-bedrock", catalog);
		}
	} else {
		bedrockModels = normalizeProviderModels("amazon-bedrock", catalog);
	}

	const file: UnifiedModelsFile = {
		version: 1,
		generatedAt: new Date().toISOString(),
		providers: {
			openrouter: normalizeProviderModels("openrouter", catalog),
			"opencode-go": normalizeProviderModels("opencode-go", catalog),
			"opencode-zen": normalizeProviderModels("opencode-zen", catalog),
			deepseek: normalizeProviderModels("deepseek", catalog),
			"amazon-bedrock": bedrockModels,
		},
	};
	fs.mkdirSync(resolvedConfigDir, { recursive: true });
	const configPath = getUnifiedModelsFilePath(resolvedConfigDir);
	fs.writeFileSync(configPath, JSON.stringify(file, null, "\t"));
	const modelCount = Object.values(file.providers).reduce((sum, models) => sum + models.length, 0);
	return {
		configPath,
		providerCount: Object.keys(file.providers).length,
		modelCount,
		multiplierSourceAvailable: false,
	};
}

/**
 * Maps an AWS region to the geographic prefix used by cross-region inference profiles.
 * Returns undefined for regions where no standard prefix is known.
 */
export function regionToInferencePrefix(region: string): string | undefined {
	if (region.startsWith("us-")) return "us";
	if (region.startsWith("eu-")) return "eu";
	if (region.startsWith("ap-")) return "ap";
	return undefined;
}

/** Builds a lookup map from model ID → models.dev entry for the amazon-bedrock provider. */
function buildModelsDevIndex(catalog: ModelsDevCatalog): Record<string, ModelsDevModel> {
	const source = catalog["amazon-bedrock"];
	if (!source) return {};
	return Object.fromEntries(Object.values(source.models).map((m) => [m.id, m]));
}

/**
 * Pure helper: converts a list of Bedrock foundation model summaries into
 * UnifiedProviderModel entries, applying all filtering and enrichment rules.
 *
 * Models are excluded when:
 * - outputModalities does not include TEXT
 * - responseStreamingSupported is false (required for /converse-stream)
 * - contextWindow or maxOutput could not be resolved from models.dev (> 0 required)
 *
 * Models that lack ON_DEMAND support get the appropriate regional prefix
 * (eu., us., ap.) so the callable ID is correct for the Converse API.
 */
function buildBedrockModels(
	foundationModels: BedrockFoundationModelSummary[],
	region: string,
	modelsDevById: Record<string, ModelsDevModel>,
): UnifiedProviderModel[] {
	const inferencePrefix = regionToInferencePrefix(region);

	return foundationModels
		.filter((m) => m.responseStreamingSupported !== false && m.outputModalities.includes("TEXT"))
		.flatMap((m) => {
			const onDemandSupported = m.inferenceTypesSupported?.includes("ON_DEMAND") ?? true;
			const callableId = !onDemandSupported && inferencePrefix ? `${inferencePrefix}.${m.modelId}` : m.modelId;

			// Look up metadata by callable ID first, then fall back to the bare model ID.
			const dev = modelsDevById[callableId] ?? modelsDevById[m.modelId];
			const contextWindow = dev?.limit?.context ?? 0;
			const maxOutput = dev?.limit?.output ?? 0;

			// Skip models whose context window or max output is unknown — passing
			// maxTokens: 0 to the Converse API causes a 400 validation error.
			if (contextWindow === 0 || maxOutput === 0) return [];

			return [
				{
					id: callableId,
					name: dev?.name ?? m.modelName,
					contextWindow,
					maxOutput,
					inputPrice: dev?.cost?.input ?? 0,
					outputPrice: dev?.cost?.output ?? 0,
					...(typeof dev?.cost?.cache_read === "number" ? { cacheReadPrice: dev.cost.cache_read } : {}),
					...(typeof dev?.cost?.cache_write === "number" ? { cacheWritePrice: dev.cost.cache_write } : {}),
				},
			];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

export interface RefreshBedrockModelsResult {
	configPath: string;
	modelCount: number;
	/** Models excluded because contextWindow or maxOutput could not be resolved. */
	skippedModelCount: number;
}

/**
 * Updates the `amazon-bedrock` section of models.json using the list of
 * foundation models returned by the Bedrock service API, enriched with
 * pricing/context metadata from models.dev.
 *
 * Models are excluded when context window or max output cannot be resolved —
 * passing maxTokens: 0 to the Converse API causes a 400 validation error.
 * Other provider sections in the file are left untouched.
 *
 * @param foundationModels - Models returned by GET /foundation-models
 * @param region - The user's AWS region (used to derive the cross-region prefix)
 * @param configDir - Config directory where models.json lives (defaults to ~/.config/bobai)
 * @param deps - Optional dependency overrides for testing
 */
export async function refreshBedrockModelsFromFoundation(
	foundationModels: BedrockFoundationModelSummary[],
	region: string,
	configDir?: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<RefreshBedrockModelsResult> {
	const resolvedConfigDir = configDir ?? defaultConfigDir();

	// Fetch models.dev for enrichment, but don't hard-fail if it's unreachable —
	// models with unresolvable metadata will simply be skipped.
	let modelsDevById: Record<string, ModelsDevModel> = {};
	try {
		const catalog = await fetchModelsDevCatalog(deps.fetch);
		modelsDevById = buildModelsDevIndex(catalog);
	} catch {
		// Proceed with empty index; all models will be skipped (no metadata)
	}

	const eligible = foundationModels.filter(
		(m) => m.responseStreamingSupported !== false && m.outputModalities.includes("TEXT"),
	);
	const enriched = buildBedrockModels(foundationModels, region, modelsDevById);
	const skippedModelCount = eligible.length - enriched.length;

	// Load or create the models file, preserving other providers.
	let file: UnifiedModelsFile;
	try {
		file = loadUnifiedModelsFile(resolvedConfigDir);
	} catch {
		file = {
			version: 1,
			generatedAt: new Date().toISOString(),
			providers: {
				openrouter: [],
				"opencode-go": [],
				"opencode-zen": [],
				deepseek: [],
				"amazon-bedrock": [],
			},
		};
	}

	file.providers["amazon-bedrock"] = enriched;
	file.generatedAt = new Date().toISOString();

	fs.mkdirSync(resolvedConfigDir, { recursive: true });
	const configPath = getUnifiedModelsFilePath(resolvedConfigDir);
	fs.writeFileSync(configPath, JSON.stringify(file, null, "\t"));

	return { configPath, modelCount: enriched.length, skippedModelCount };
}
