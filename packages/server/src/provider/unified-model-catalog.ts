import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchModelsDevCatalog, type ModelsDevCatalog, type ModelsDevModel } from "../models-catalog";
import type { ProviderId } from "./providers";

export interface UnifiedProviderModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	inputPrice: number;
	outputPrice: number;
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

export async function refreshUnifiedModelCatalog(configDir?: string): Promise<UnifiedModelCatalogRefreshResult> {
	const resolvedConfigDir = configDir ?? defaultConfigDir();
	const catalog = await fetchModelsDevCatalog();
	const copilotMultipliers = await fetchCopilotMultiplierMap();
	const file: UnifiedModelsFile = {
		version: 1,
		generatedAt: new Date().toISOString(),
		providers: {
			"github-copilot": normalizeProviderModels("github-copilot", catalog, copilotMultipliers),
			openrouter: normalizeProviderModels("openrouter", catalog, copilotMultipliers),
			"opencode-go": normalizeProviderModels("opencode-go", catalog, copilotMultipliers),
			"opencode-zen": normalizeProviderModels("opencode-zen", catalog, copilotMultipliers),
			"amazon-bedrock": normalizeProviderModels("amazon-bedrock", catalog, copilotMultipliers),
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
