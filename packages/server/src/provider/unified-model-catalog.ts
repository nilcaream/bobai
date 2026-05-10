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
const COPILOT_REQUESTS_URL = "https://docs.github.com/en/copilot/concepts/billing/copilot-requests";

const PROVIDER_SOURCE_MAP: Record<ProviderId, string> = {
	"github-copilot": "github-copilot",
	openrouter: "openrouter",
	"opencode-go": "opencode-go",
	"opencode-zen": "opencode",
	"amazon-bedrock": "amazon-bedrock",
	deepseek: "deepseek",
};

const COPILOT_MULTIPLIER_MODEL_ID_MAP: Record<string, string> = {
	"claude haiku 4.5": "claude-haiku-4.5",
	"claude opus 4.5": "claude-opus-4.5",
	"claude opus 4.6": "claude-opus-4.6",
	"claude opus 4.6 (fast mode)": "claude-opus-4.6-fast",
	"claude opus 4.7": "claude-opus-4.7",
	"claude sonnet 4": "claude-sonnet-4",
	"claude sonnet 4.5": "claude-sonnet-4.5",
	"claude sonnet 4.6": "claude-sonnet-4.6",
	"gemini 2.5 pro": "gemini-2.5-pro",
	"gemini 3 flash": "gemini-3-flash-preview",
	"gemini 3.1 pro": "gemini-3.1-pro-preview",
	"gpt-4.1": "gpt-4.1",
	"gpt-4o": "gpt-4o",
	"gpt-5 mini": "gpt-5-mini",
	"gpt-5": "gpt-5",
	"gpt-5.2": "gpt-5.2",
	"gpt-5.2-codex": "gpt-5.2-codex",
	"gpt-5.3-codex": "gpt-5.3-codex",
	"gpt-5.4": "gpt-5.4",
	"gpt-5.4 mini": "gpt-5.4-mini",
	"gpt-5.4 nano": "gpt-5.4-nano",
	"gpt-5.5": "gpt-5.5",
	"grok code fast 1": "grok-code-fast-1",
	"raptor mini": "raptor-mini",
	goldeneye: "goldeneye",
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

async function fetchCopilotMultiplierMap(): Promise<Map<string, number>> {
	let response: Response;
	try {
		response = await fetch(COPILOT_REQUESTS_URL);
	} catch {
		return new Map();
	}
	if (!response.ok) {
		return new Map();
	}
	const html = await response.text();
	const rows = [...html.matchAll(/<tr><th[^>]*scope="row"[^>]*>(.*?)<\/th><td>(.*?)<\/td><td>/g)];
	const multipliers = new Map<string, number>();
	for (const row of rows) {
		const modelName = normalizeCopilotDocModelName(stripHtml(row[1] ?? ""));
		const multiplierText = stripHtml(row[2] ?? "").trim();
		const modelId = COPILOT_MULTIPLIER_MODEL_ID_MAP[modelName];
		const multiplier = Number.parseFloat(multiplierText);
		if (!modelId || Number.isNaN(multiplier)) continue;
		multipliers.set(modelId, multiplier);
	}
	return multipliers;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeCopilotDocModelName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\(preview\)/g, "")
		.replace(/\s+/g, " ")
		.trim();
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

function normalizeProviderModels(
	providerId: ProviderId,
	catalog: ModelsDevCatalog,
	copilotMultipliers: Map<string, number>,
): UnifiedProviderModel[] {
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
				inputPrice: providerId === "github-copilot" ? 0 : model.cost.input,
				outputPrice: providerId === "github-copilot" ? 0 : model.cost.output,
			};
			if (providerId !== "github-copilot") {
				if (typeof model.cost.cache_read === "number") {
					base.cacheReadPrice = model.cost.cache_read;
				}
				if (typeof model.cost.cache_write === "number") {
					base.cacheWritePrice = model.cost.cache_write;
				}
			}
			if (providerId === "github-copilot") {
				const multiplier = copilotMultipliers.get(model.id);
				if (multiplier !== undefined) {
					base.premiumRequestMultiplier = multiplier;
				}
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
	const copilotMultipliers = await fetchCopilotMultiplierMap();

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
			bedrockModels = normalizeProviderModels("amazon-bedrock", catalog, copilotMultipliers);
		}
	} else {
		bedrockModels = normalizeProviderModels("amazon-bedrock", catalog, copilotMultipliers);
	}

	const file: UnifiedModelsFile = {
		version: 1,
		generatedAt: new Date().toISOString(),
		providers: {
			"github-copilot": normalizeProviderModels("github-copilot", catalog, copilotMultipliers),
			openrouter: normalizeProviderModels("openrouter", catalog, copilotMultipliers),
			"opencode-go": normalizeProviderModels("opencode-go", catalog, copilotMultipliers),
			"opencode-zen": normalizeProviderModels("opencode-zen", catalog, copilotMultipliers),
			deepseek: normalizeProviderModels("deepseek", catalog, copilotMultipliers),
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
		multiplierSourceAvailable: copilotMultipliers.size > 0,
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
				"github-copilot": [],
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
