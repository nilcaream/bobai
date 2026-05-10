import type { Database } from "bun:sqlite";
import { getAssistantMessagesWithTurnMetrics, getDescendantSessionIds } from "../session/repository";
import { computeTurnCostDollars, formatPremiumRequests } from "./cost-utils";
import type { ProviderId } from "./providers";
import { getProviderDescriptor, type ProviderModelConfig, type SortedProviderModelListItem } from "./registry";

function getDescriptor(providerId: ProviderId) {
	const descriptor = getProviderDescriptor(providerId);
	if (!descriptor) {
		throw new Error(`Unsupported provider: ${providerId}`);
	}
	return descriptor;
}

export type { ProviderModelConfig, SortedProviderModelListItem };

export function providerModelsConfigExists(providerId: ProviderId, configDir?: string): boolean {
	return getDescriptor(providerId).modelsConfigExists(configDir);
}

export function loadProviderModelsConfig(providerId: ProviderId, configDir?: string): ProviderModelConfig[] {
	return getDescriptor(providerId).loadModels(configDir);
}

export function getProviderModelConfig(
	providerId: ProviderId,
	modelId: string,
	configDir?: string,
): ProviderModelConfig | undefined {
	return loadProviderModelsConfig(providerId, configDir).find((model) => model.id === modelId);
}

export function buildSortedProviderModelList(providerId: ProviderId, configDir?: string): SortedProviderModelListItem[] {
	return getDescriptor(providerId).buildSortedModels(configDir);
}

export function formatProviderModelDisplay(
	providerId: ProviderId,
	modelId: string,
	promptTokens: number,
	configDir?: string,
	contextLimit?: number | null,
	sessionCostDisplay?: string,
): string {
	return getDescriptor(providerId).formatModelDisplay(modelId, promptTokens, configDir, contextLimit, sessionCostDisplay);
}

export function computeDollarSessionTotal(db: Database, rootSessionId: string, configDir?: string): string {
	const descendantIds = getDescendantSessionIds(db, rootSessionId);
	const allSessionIds = [rootSessionId, ...descendantIds];
	const turns = getAssistantMessagesWithTurnMetrics(db, allSessionIds);

	let total = 0;
	for (const turn of turns) {
		if (turn.inputTokensTotal == null || turn.outputTokensTotal == null) continue;
		const session = getSessionProvider(db, turn.sessionId);
		const providerId = session?.provider as ProviderId | undefined;
		if (!providerId) continue;
		const modelConfig = getProviderModelConfig(providerId, turn.turnModel as string, configDir);
		if (!modelConfig || modelConfig.inputPrice == null || modelConfig.outputPrice == null) continue;

		total += computeTurnCostDollars(
			turn.inputTokensTotal,
			turn.outputTokensTotal,
			turn.cachedInputTokensTotal ?? 0,
			turn.cacheCreationInputTokensTotal ?? 0,
			modelConfig,
		);
	}

	return `$${total.toFixed(2)}`;
}

export function computeCopilotSessionTotal(db: Database, sessionId: string, configDir?: string): string {
	const turns = getAssistantMessagesWithTurnMetrics(db, [sessionId]);

	let total = 0;
	let unknown = false;
	for (const turn of turns) {
		const modelConfig = getProviderModelConfig("github-copilot", turn.turnModel as string, configDir);
		if (modelConfig?.premiumRequestMultiplier === undefined) {
			unknown = true;
			continue;
		}
		total += modelConfig.premiumRequestMultiplier;
	}

	if (unknown) {
		return "? PR";
	}
	return `${formatPremiumRequests(total)} PR`;
}

export function formatSessionCostDisplay(db: Database, providerId: ProviderId, sessionId: string, configDir?: string): string {
	if (providerId === "github-copilot") {
		return computeCopilotSessionTotal(db, sessionId, configDir);
	}
	return computeDollarSessionTotal(db, sessionId, configDir);
}

function getSessionProvider(db: Database, sessionId: string): { provider: string | null } | null {
	const row = db.prepare("SELECT provider FROM sessions WHERE id = ?").get(sessionId) as { provider: string | null } | null;
	return row;
}
