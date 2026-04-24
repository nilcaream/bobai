import type { AuthStore, CopilotAuth, OpenCodeGoAuth, OpenRouterAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import {
	buildSortedModelList,
	formatModelDisplay,
	loadModelsConfig,
	modelsConfigExists,
	type SortedModelListItem,
} from "./copilot-models";
import { loadOpenCodeGoModelsConfig } from "./opencode-go-models";
import { loadOpenRouterModelsConfig } from "./openrouter-models";
import type { Provider } from "./provider";

export const SUPPORTED_RUNTIME_PROVIDER_IDS = ["github-copilot", "openrouter", "opencode-go"] as const;
export const SUPPORTED_AUTH_PROVIDER_IDS = ["github-copilot", "openrouter", "opencode-go"] as const;
export const DEFAULT_PROVIDER_ID = "github-copilot" as const;

export type ProviderId = (typeof SUPPORTED_RUNTIME_PROVIDER_IDS)[number];
export type AuthProviderId = (typeof SUPPORTED_AUTH_PROVIDER_IDS)[number];
export type ApiFamily = "anthropic-messages" | "openai-responses" | "openai-chat-completions";

export interface ProviderModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	label?: string;
	inputPrice?: number;
	outputPrice?: number;
}

export type SortedProviderModelListItem = SortedModelListItem;

export interface ProviderSummaryParts {
	modelName: string;
	pricingLabel?: string;
	costEstimate?: string;
}

export interface ProviderAuthMetadata {
	cliCommand: string;
	missingAuthMessage: string;
	permanentAuthErrorMessage: string;
}

export interface ProviderDescriptor {
	id: ProviderId;
	authSupported: boolean;
	runtimeSupported: boolean;
	defaultModel: string;
	auth: ProviderAuthMetadata;
	getApiFamily(modelId: string): ApiFamily;
	modelsConfigExists(configDir?: string): boolean;
	loadModels(configDir?: string): ProviderModelConfig[];
	buildSortedModels(configDir?: string): SortedProviderModelListItem[];
	formatModelDisplay(modelId: string, promptTokens: number, configDir?: string): string;
	buildTurnSummaryParts?(options: {
		modelId: string;
		inputTokens: number;
		outputTokens: number;
		configDir?: string;
	}): ProviderSummaryParts;
	createConfiguredProvider(options: {
		configDir: string;
		logger?: Logger;
		store?: AuthStore;
		authorizeCopilot?: (configDir: string) => Promise<CopilotAuth>;
		createCopilotProvider?: (auth: CopilotAuth, configDir?: string, logger?: Logger) => Provider;
		createOpenRouterProvider?: (auth: OpenRouterAuth, logger?: Logger) => Provider;
		createOpenCodeGoProvider?: (auth: OpenCodeGoAuth, logger?: Logger) => Provider;
	}): Promise<Provider>;
}

function formatGenericProviderModelDisplay(
	providerId: ProviderId,
	modelConfig: ProviderModelConfig | undefined,
	promptTokens: number,
): string {
	const label = modelConfig?.label ? ` | ${modelConfig.label}` : "";
	const contextWindow = modelConfig?.contextWindow ?? 0;
	const percent = contextWindow > 0 ? Math.round((promptTokens / contextWindow) * 100) : 0;
	return `${providerId} | ${modelConfig?.id ?? "unknown-model"}${label} | ${promptTokens} / ${contextWindow} | ${percent}%`;
}

const githubCopilotDescriptor: ProviderDescriptor = {
	id: "github-copilot",
	authSupported: true,
	runtimeSupported: true,
	defaultModel: "gpt-5-mini",
	auth: {
		cliCommand: "bobai auth github-copilot",
		missingAuthMessage: "No auth found. Run `bobai auth github-copilot` first.",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth github-copilot` to re-authenticate.",
	},
	getApiFamily(modelId: string): ApiFamily {
		if (/^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId)) return "anthropic-messages";
		const match = /^gpt-(\d+)/.exec(modelId);
		if (match && Number(match[1]) >= 5 && !modelId.startsWith("gpt-5-mini")) return "openai-responses";
		return "openai-chat-completions";
	},
	modelsConfigExists(configDir?: string): boolean {
		return modelsConfigExists(configDir);
	},
	loadModels(configDir?: string): ProviderModelConfig[] {
		return loadModelsConfig(configDir);
	},
	buildSortedModels(configDir?: string): SortedProviderModelListItem[] {
		return buildSortedModelList(loadModelsConfig(configDir));
	},
	formatModelDisplay(modelId: string, promptTokens: number, configDir?: string): string {
		return `${this.id} | ${formatModelDisplay(modelId, promptTokens, configDir)}`;
	},
	buildTurnSummaryParts(options): ProviderSummaryParts {
		const modelConfig = this.loadModels(options.configDir).find((model) => model.id === options.modelId);
		return {
			modelName: options.modelId,
			pricingLabel: modelConfig?.label ?? formatModelDisplay(options.modelId, 0, options.configDir).split(" | ")[1],
		};
	},
	async createConfiguredProvider(options): Promise<Provider> {
		let auth = options.store?.providers["github-copilot"];
		if (!auth) {
			const authorizeModule = await import("../auth/authorize");
			const authorizeCopilot = options.authorizeCopilot ?? authorizeModule.authorizeCopilot;
			auth = await authorizeCopilot(options.configDir);
		}
		const copilotModule = await import("./copilot");
		const createCopilotProvider = options.createCopilotProvider ?? copilotModule.createCopilotProvider;
		return createCopilotProvider(auth, options.configDir, options.logger);
	},
};

const openRouterDescriptor: ProviderDescriptor = {
	id: "openrouter",
	authSupported: true,
	runtimeSupported: true,
	defaultModel: "openrouter/free",
	auth: {
		cliCommand: "bobai auth openrouter",
		missingAuthMessage: "OpenRouter authentication not found. Please run: bobai auth openrouter",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth openrouter` to re-authenticate.",
	},
	getApiFamily(): ApiFamily {
		return "openai-chat-completions";
	},
	modelsConfigExists(): boolean {
		return true;
	},
	loadModels(): ProviderModelConfig[] {
		return loadOpenRouterModelsConfig();
	},
	buildSortedModels(): SortedProviderModelListItem[] {
		return loadOpenRouterModelsConfig()
			.map((model) => ({ id: model.id, cost: model.label, contextWindow: model.contextWindow }))
			.sort((a, b) => a.id.localeCompare(b.id));
	},
	formatModelDisplay(modelId: string, promptTokens: number): string {
		return formatGenericProviderModelDisplay(
			this.id,
			this.loadModels().find((model) => model.id === modelId),
			promptTokens,
		);
	},
	buildTurnSummaryParts(options): ProviderSummaryParts {
		const modelConfig = this.loadModels(options.configDir).find((model) => model.id === options.modelId);
		const modelName = options.modelId.includes("/") ? (options.modelId.split("/").at(-1) ?? options.modelId) : options.modelId;
		if (modelConfig?.label === "free") {
			return { modelName, costEstimate: "free" };
		}
		if (modelConfig?.inputPrice !== undefined && modelConfig.outputPrice !== undefined) {
			const cost = (options.inputTokens * modelConfig.inputPrice + options.outputTokens * modelConfig.outputPrice) / 1_000_000;
			return { modelName, costEstimate: `$${cost.toFixed(2)}` };
		}
		return { modelName };
	},
	async createConfiguredProvider(options): Promise<Provider> {
		const auth = options.store?.providers.openrouter;
		if (!auth) {
			throw new Error("OpenRouter authentication not found. Please run: bobai auth openrouter");
		}
		const openRouterModule = await import("./openrouter");
		const createOpenRouterProvider = options.createOpenRouterProvider ?? openRouterModule.createOpenRouterProvider;
		return createOpenRouterProvider(auth, options.logger);
	},
};

const openCodeGoDescriptor: ProviderDescriptor = {
	id: "opencode-go",
	authSupported: true,
	runtimeSupported: true,
	defaultModel: "kimi-k2.6",
	auth: {
		cliCommand: "bobai auth opencode-go",
		missingAuthMessage: "OpenCode Go authentication not found. Please run: bobai auth opencode-go",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth opencode-go` to re-authenticate.",
	},
	getApiFamily(modelId: string): ApiFamily {
		return modelId.startsWith("minimax-") ? "anthropic-messages" : "openai-chat-completions";
	},
	modelsConfigExists(): boolean {
		return true;
	},
	loadModels(): ProviderModelConfig[] {
		return loadOpenCodeGoModelsConfig();
	},
	buildSortedModels(): SortedProviderModelListItem[] {
		return loadOpenCodeGoModelsConfig()
			.map((model) => ({ id: model.id, cost: model.label, contextWindow: model.contextWindow }))
			.sort((a, b) => a.id.localeCompare(b.id));
	},
	formatModelDisplay(modelId: string, promptTokens: number): string {
		return formatGenericProviderModelDisplay(
			this.id,
			this.loadModels().find((model) => model.id === modelId),
			promptTokens,
		);
	},
	buildTurnSummaryParts(options): ProviderSummaryParts {
		return {
			modelName: options.modelId.includes("/") ? (options.modelId.split("/").at(-1) ?? options.modelId) : options.modelId,
		};
	},
	async createConfiguredProvider(options): Promise<Provider> {
		const auth = options.store?.providers["opencode-go"];
		if (!auth) {
			throw new Error("OpenCode Go authentication not found. Please run: bobai auth opencode-go");
		}
		const openCodeGoModule = await import("./opencode-go");
		const createOpenCodeGoProvider = options.createOpenCodeGoProvider ?? openCodeGoModule.createOpenCodeGoProvider;
		return createOpenCodeGoProvider(auth, options.logger);
	},
};

const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
	"github-copilot": githubCopilotDescriptor,
	openrouter: openRouterDescriptor,
	"opencode-go": openCodeGoDescriptor,
};

export function getProviderDescriptor(providerId: ProviderId): ProviderDescriptor;
export function getProviderDescriptor(providerId: string): ProviderDescriptor | undefined;
export function getProviderDescriptor(providerId: string): ProviderDescriptor | undefined {
	return PROVIDER_DESCRIPTORS[providerId as ProviderId];
}

export function listRuntimeProviders(): ProviderDescriptor[] {
	return SUPPORTED_RUNTIME_PROVIDER_IDS.map((providerId) => PROVIDER_DESCRIPTORS[providerId]);
}

export function listAuthProviders(): ProviderDescriptor[] {
	return SUPPORTED_AUTH_PROVIDER_IDS.map((providerId) => PROVIDER_DESCRIPTORS[providerId]);
}

export function getProviderAuthMetadata(providerId: string): ProviderAuthMetadata | undefined {
	return getProviderDescriptor(providerId)?.auth;
}
