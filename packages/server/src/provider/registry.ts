import type {
	AmazonBedrockAuth,
	AuthStore,
	DeepSeekAuth,
	OpenCodeGoAuth,
	OpenCodeZenAuth,
	OpenRouterAuth,
} from "../auth/store";
import type { Logger } from "../log/logger";
import { computeTurnCostDollars } from "./cost-utils";
import type { Provider } from "./provider";
import { loadUnifiedModelsFile, unifiedModelsConfigExists } from "./unified-model-catalog";

export const SUPPORTED_RUNTIME_PROVIDER_IDS = [
	"openrouter",
	"opencode-go",
	"opencode-zen",
	"amazon-bedrock",
	"deepseek",
] as const;
export const SUPPORTED_AUTH_PROVIDER_IDS = [
	"openrouter",
	"opencode-go",
	"opencode-zen",
	"amazon-bedrock",
	"deepseek",
	"tavily",
] as const;

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
	cacheReadPrice?: number;
	cacheWritePrice?: number;
	supportsCaching?: boolean;
	premiumRequestMultiplier?: number;
}

export type SortedProviderModelListItem = {
	id: string;
	cost: string;
	contextWindow: number;
};

export interface ProviderSummaryParts {
	modelName: string;
	pricingLabel?: string;
	costEstimate?: string;
	/** 'estimate' for computed dollar costs, 'exact' for premium request costs. */
	costLabelType?: "estimate" | "exact";
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
	formatModelDisplay(
		modelId: string,
		promptTokens: number,
		configDir?: string,
		contextLimit?: number | null,
		sessionCostDisplay?: string,
	): string;
	buildTurnSummaryParts?(options: {
		modelId: string;
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens?: number;
		cacheCreationInputTokens?: number;
		premiumRequests?: number;
		configDir?: string;
		billable?: boolean;
	}): ProviderSummaryParts;
	createConfiguredProvider(options: {
		configDir: string;
		logger?: Logger;
		store?: AuthStore;
		fetch?: typeof fetch;
		createOpenRouterProvider?: (auth: OpenRouterAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createOpenCodeGoProvider?: (auth: OpenCodeGoAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createOpenCodeZenProvider?: (auth: OpenCodeZenAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createAmazonBedrockProvider?: (
			auth: AmazonBedrockAuth,
			logger?: Logger,
			fetchFn?: typeof fetch,
			configDir?: string,
		) => Provider;
		createDeepSeekProvider?: (auth: DeepSeekAuth, logger?: Logger, fetchFn?: typeof fetch, configDir?: string) => Provider;
	}): Promise<Provider>;
}

function formatPrice(value: number | undefined): string {
	return `$${(value ?? 0).toFixed(2)}`;
}

function formatProviderCostLabel(_providerId: ProviderId, modelConfig: ProviderModelConfig | undefined): string {
	if (!modelConfig) {
		return `[${formatPrice(0)} ${formatPrice(0)}]`;
	}
	return `[${formatPrice(modelConfig.inputPrice)} ${formatPrice(modelConfig.outputPrice)}]`;
}

function formatProviderSummaryCostEstimate(
	providerId: ProviderId,
	modelConfig: ProviderModelConfig | undefined,
): string | undefined {
	if (!modelConfig) return undefined;
	if (providerId === "openrouter" && modelConfig.inputPrice === 0 && modelConfig.outputPrice === 0) {
		return "free";
	}
	return undefined;
}

function formatGenericProviderModelDisplay(
	providerId: ProviderId,
	modelId: string,
	modelConfig: ProviderModelConfig | undefined,
	promptTokens: number,
	contextLimit?: number | null,
	sessionCostDisplay?: string,
): string {
	const costLabel = formatProviderCostLabel(providerId, modelConfig);
	const defaultZeroCost = "$0.00";
	const costTotal = sessionCostDisplay ?? defaultZeroCost;
	const defaultContextWindow = modelConfig?.contextWindow ?? 0;
	const effectiveLimit = contextLimit && contextLimit > 0 ? contextLimit : defaultContextWindow;
	const percent = effectiveLimit > 0 ? Math.round((promptTokens / effectiveLimit) * 100) : 0;
	const contextDisplay =
		contextLimit && contextLimit > 0
			? `${promptTokens} / ${contextLimit} (${defaultContextWindow})`
			: `${promptTokens} / ${defaultContextWindow}`;
	return `${providerId} | ${modelConfig?.id ?? modelId} ${costLabel} | ${costTotal} | ${contextDisplay} | ${percent}%`;
}

function defaultModelName(modelId: string): string {
	return modelId.includes("/") ? (modelId.split("/").at(-1) ?? modelId) : modelId;
}

function loadProviderModelsFromUnifiedCatalog(providerId: ProviderId, configDir?: string): ProviderModelConfig[] {
	try {
		return loadUnifiedModelsFile(configDir).providers[providerId] ?? [];
	} catch {
		return [];
	}
}

interface ApiKeyProviderDescriptorOptions<Auth> {
	id: ProviderId;
	defaultModel: string;
	auth: ProviderAuthMetadata;
	getApiFamily(modelId: string): ApiFamily;
	buildTurnSummaryParts?: (options: {
		modelId: string;
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens?: number;
		cacheCreationInputTokens?: number;
		premiumRequests?: number;
		configDir?: string;
		billable?: boolean;
	}) => ProviderSummaryParts;
	getAuth(store: AuthStore | undefined): Auth | undefined;
	missingAuthMessage: string;
	createProvider(options: {
		auth: Auth;
		logger?: Logger;
		fetch?: typeof fetch;
		configDir?: string;
		createOpenRouterProvider?: (auth: OpenRouterAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createOpenCodeGoProvider?: (auth: OpenCodeGoAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createOpenCodeZenProvider?: (auth: OpenCodeZenAuth, logger?: Logger, fetchFn?: typeof fetch) => Provider;
		createAmazonBedrockProvider?: (
			auth: AmazonBedrockAuth,
			logger?: Logger,
			fetchFn?: typeof fetch,
			configDir?: string,
		) => Provider;
		createDeepSeekProvider?: (auth: DeepSeekAuth, logger?: Logger, fetchFn?: typeof fetch, configDir?: string) => Provider;
	}): Promise<Provider>;
}

function createApiKeyProviderDescriptor<Auth>(options: ApiKeyProviderDescriptorOptions<Auth>): ProviderDescriptor {
	return {
		id: options.id,
		authSupported: true,
		runtimeSupported: true,
		defaultModel: options.defaultModel,
		auth: options.auth,
		getApiFamily: options.getApiFamily,
		modelsConfigExists(configDir?: string): boolean {
			return unifiedModelsConfigExists(configDir);
		},
		loadModels(configDir?: string): ProviderModelConfig[] {
			return loadProviderModelsFromUnifiedCatalog(options.id, configDir);
		},
		buildSortedModels(configDir?: string): SortedProviderModelListItem[] {
			return loadProviderModelsFromUnifiedCatalog(options.id, configDir)
				.map((model) => ({
					id: model.id,
					cost: formatProviderCostLabel(options.id, model),
					contextWindow: model.contextWindow,
				}))
				.sort((a, b) => a.id.localeCompare(b.id));
		},
		formatModelDisplay(
			modelId: string,
			promptTokens: number,
			configDir?: string,
			contextLimit?: number | null,
			sessionCostDisplay?: string,
		): string {
			return formatGenericProviderModelDisplay(
				options.id,
				modelId,
				loadProviderModelsFromUnifiedCatalog(options.id, configDir).find((model) => model.id === modelId),
				promptTokens,
				contextLimit,
				sessionCostDisplay,
			);
		},
		buildTurnSummaryParts(summaryOptions): ProviderSummaryParts {
			if (options.buildTurnSummaryParts) {
				return options.buildTurnSummaryParts(summaryOptions);
			}
			const modelName = defaultModelName(summaryOptions.modelId);
			const modelConfig = loadProviderModelsFromUnifiedCatalog(options.id, summaryOptions.configDir).find(
				(model) => model.id === summaryOptions.modelId,
			);
			if (
				modelConfig?.inputPrice !== undefined &&
				modelConfig.outputPrice !== undefined &&
				(summaryOptions.inputTokens > 0 || summaryOptions.outputTokens > 0)
			) {
				const cost = computeTurnCostDollars(
					summaryOptions.inputTokens,
					summaryOptions.outputTokens,
					summaryOptions.cachedInputTokens ?? 0,
					summaryOptions.cacheCreationInputTokens ?? 0,
					modelConfig,
				);
				return { modelName, costEstimate: `$${cost.toFixed(2)}`, costLabelType: "estimate" };
			}
			if (options.id === "openrouter" && modelConfig?.inputPrice === 0 && modelConfig.outputPrice === 0) {
				return { modelName, costEstimate: "free" };
			}
			return { modelName };
		},
		async createConfiguredProvider(providerOptions): Promise<Provider> {
			const auth = options.getAuth(providerOptions.store);
			if (!auth) {
				throw new Error(options.missingAuthMessage);
			}
			return options.createProvider({
				auth,
				logger: providerOptions.logger,
				fetch: providerOptions.fetch,
				configDir: providerOptions.configDir,
				createOpenRouterProvider: providerOptions.createOpenRouterProvider,
				createOpenCodeGoProvider: providerOptions.createOpenCodeGoProvider,
				createOpenCodeZenProvider: providerOptions.createOpenCodeZenProvider,
				createAmazonBedrockProvider: providerOptions.createAmazonBedrockProvider,
				createDeepSeekProvider: providerOptions.createDeepSeekProvider,
			});
		},
	};
}

const openRouterDescriptor = createApiKeyProviderDescriptor<OpenRouterAuth>({
	id: "openrouter",
	defaultModel: "openrouter/free",
	auth: {
		cliCommand: "bobai auth openrouter",
		missingAuthMessage: "OpenRouter authentication not found. Please run: bobai auth openrouter",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth openrouter` to re-authenticate.",
	},
	getApiFamily(): ApiFamily {
		return "openai-chat-completions";
	},
	buildTurnSummaryParts(options): ProviderSummaryParts {
		const modelConfig = loadProviderModelsFromUnifiedCatalog("openrouter", options.configDir).find(
			(model) => model.id === options.modelId,
		);
		const modelName = defaultModelName(options.modelId);
		const staticEstimate = formatProviderSummaryCostEstimate("openrouter", modelConfig);
		if (staticEstimate) {
			return { modelName, costEstimate: staticEstimate };
		}
		if (
			modelConfig?.inputPrice !== undefined &&
			modelConfig.outputPrice !== undefined &&
			(options.inputTokens > 0 || options.outputTokens > 0)
		) {
			const cost = computeTurnCostDollars(
				options.inputTokens,
				options.outputTokens,
				options.cachedInputTokens ?? 0,
				options.cacheCreationInputTokens ?? 0,
				modelConfig,
			);
			return { modelName, costEstimate: `$${cost.toFixed(2)}`, costLabelType: "estimate" };
		}
		return { modelName };
	},
	getAuth(store) {
		return store?.providers.openrouter;
	},
	missingAuthMessage: "OpenRouter authentication not found. Please run: bobai auth openrouter",
	async createProvider(options): Promise<Provider> {
		const openRouterModule = await import("./openrouter");
		const createOpenRouterProvider = options.createOpenRouterProvider ?? openRouterModule.createOpenRouterProvider;
		return createOpenRouterProvider(options.auth, options.logger, options.fetch, options.configDir);
	},
});

const openCodeGoDescriptor = createApiKeyProviderDescriptor<OpenCodeGoAuth>({
	id: "opencode-go",
	defaultModel: "deepseek-v4-flash",
	auth: {
		cliCommand: "bobai auth opencode-go",
		missingAuthMessage: "OpenCode Go authentication not found. Please run: bobai auth opencode-go",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth opencode-go` to re-authenticate.",
	},
	getApiFamily(modelId: string): ApiFamily {
		return modelId.startsWith("minimax-") ? "anthropic-messages" : "openai-chat-completions";
	},
	getAuth(store) {
		return store?.providers["opencode-go"];
	},
	missingAuthMessage: "OpenCode Go authentication not found. Please run: bobai auth opencode-go",
	async createProvider(options): Promise<Provider> {
		const openCodeGoModule = await import("./opencode-go");
		const createOpenCodeGoProvider = options.createOpenCodeGoProvider ?? openCodeGoModule.createOpenCodeGoProvider;
		return createOpenCodeGoProvider(options.auth, options.logger, options.fetch, options.configDir);
	},
});

const openCodeZenDescriptor = createApiKeyProviderDescriptor<OpenCodeZenAuth>({
	id: "opencode-zen",
	defaultModel: "minimax-m2.5-free",
	auth: {
		cliCommand: "bobai auth opencode-zen",
		missingAuthMessage: "OpenCode Zen authentication not found. Please run: bobai auth opencode-zen",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth opencode-zen` to re-authenticate.",
	},
	getApiFamily(modelId: string): ApiFamily {
		if (modelId.startsWith("claude-")) return "anthropic-messages";
		if (modelId.startsWith("gpt-")) return "openai-responses";
		return "openai-chat-completions";
	},
	getAuth(store) {
		return store?.providers["opencode-zen"];
	},
	missingAuthMessage: "OpenCode Zen authentication not found. Please run: bobai auth opencode-zen",
	async createProvider(options): Promise<Provider> {
		const openCodeZenModule = await import("./opencode-zen");
		const createOpenCodeZenProvider = options.createOpenCodeZenProvider ?? openCodeZenModule.createOpenCodeZenProvider;
		return createOpenCodeZenProvider(options.auth, options.logger, options.fetch, options.configDir);
	},
});

const deepseekDescriptor = createApiKeyProviderDescriptor<DeepSeekAuth>({
	id: "deepseek",
	defaultModel: "deepseek-v4-flash",
	auth: {
		cliCommand: "bobai auth deepseek",
		missingAuthMessage: "DeepSeek authentication not found. Please run: bobai auth deepseek",
		permanentAuthErrorMessage: "Authentication expired. Run `bobai auth deepseek` to re-authenticate.",
	},
	getApiFamily(): ApiFamily {
		return "openai-chat-completions";
	},
	getAuth(store) {
		return store?.providers.deepseek;
	},
	missingAuthMessage: "DeepSeek authentication not found. Please run: bobai auth deepseek",
	async createProvider(options): Promise<Provider> {
		const deepseekModule = await import("./deepseek");
		const createDeepSeekProvider = options.createDeepSeekProvider ?? deepseekModule.createDeepSeekProvider;
		return createDeepSeekProvider(options.auth, options.logger, options.fetch, options.configDir);
	},
});

const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
	openrouter: openRouterDescriptor,
	"opencode-go": openCodeGoDescriptor,
	"opencode-zen": openCodeZenDescriptor,
	deepseek: deepseekDescriptor,
	"amazon-bedrock": createApiKeyProviderDescriptor<AmazonBedrockAuth>({
		id: "amazon-bedrock",
		defaultModel: "anthropic.claude-opus-4-7",
		auth: {
			cliCommand: "bobai auth amazon-bedrock",
			missingAuthMessage: "Amazon Bedrock authentication not found. Please run: bobai auth amazon-bedrock",
			permanentAuthErrorMessage: "Authentication expired. Run `bobai auth amazon-bedrock` to re-authenticate.",
		},
		getApiFamily(modelId: string): ApiFamily {
			// Cross-region inference prefixes (eu., us., ap.) wrap the standard model ID.
			// Strip the prefix before checking the provider family.
			const baseModelId = modelId.replace(/^(eu|us|ap)\./, "");
			return baseModelId.startsWith("anthropic.") ? "anthropic-messages" : "openai-chat-completions";
		},
		getAuth(store) {
			return store?.providers["amazon-bedrock"];
		},
		missingAuthMessage: "Amazon Bedrock authentication not found. Please run: bobai auth amazon-bedrock",
		async createProvider(options): Promise<Provider> {
			const amazonBedrockModule = await import("./amazon-bedrock");
			const createAmazonBedrockProvider =
				options.createAmazonBedrockProvider ?? amazonBedrockModule.createAmazonBedrockProvider;
			return createAmazonBedrockProvider(options.auth, options.logger, options.fetch, options.configDir);
		},
	}),
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
	return SUPPORTED_AUTH_PROVIDER_IDS.map((providerId) => PROVIDER_DESCRIPTORS[providerId]).filter(
		(d): d is ProviderDescriptor => d !== undefined,
	);
}

export function getProviderAuthMetadata(providerId: string): ProviderAuthMetadata | undefined {
	return getProviderDescriptor(providerId)?.auth;
}
