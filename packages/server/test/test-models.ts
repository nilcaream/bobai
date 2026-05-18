import fs from "node:fs";
import path from "node:path";

export function writeUnifiedModelsConfig(
	configDir: string,
	providers: {
		"github-copilot"?: unknown[];
		openrouter?: unknown[];
		"opencode-go"?: unknown[];
		"opencode-zen"?: unknown[];
		deepseek?: unknown[];
		"amazon-bedrock"?: unknown[];
	},
): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "models.json"),
		JSON.stringify(
			{
				version: 1,
				generatedAt: "2026-05-05T00:00:00.000Z",
				providers: {
					"github-copilot": providers["github-copilot"] ?? [],
					openrouter: providers.openrouter ?? [],
					"opencode-go": providers["opencode-go"] ?? [],
					"opencode-zen": providers["opencode-zen"] ?? [],
					deepseek: providers.deepseek ?? [],
					"amazon-bedrock": providers["amazon-bedrock"] ?? [],
				},
			},
			null,
			2,
		),
	);
}

export function createCopilotModels(
	models: Array<{
		id: string;
		name?: string;
		contextWindow: number;
		maxOutput: number;
		premiumRequestMultiplier?: number;
		inputPrice?: number;
		outputPrice?: number;
		cacheReadPrice?: number;
		cacheWritePrice?: number;
		supportsCaching?: boolean;
	}>,
): unknown[] {
	return models.map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		contextWindow: model.contextWindow,
		maxOutput: model.maxOutput,
		inputPrice: model.inputPrice ?? 0,
		outputPrice: model.outputPrice ?? 0,
		...(model.premiumRequestMultiplier !== undefined ? { premiumRequestMultiplier: model.premiumRequestMultiplier } : {}),
		...(model.cacheReadPrice !== undefined ? { cacheReadPrice: model.cacheReadPrice } : {}),
		...(model.cacheWritePrice !== undefined ? { cacheWritePrice: model.cacheWritePrice } : {}),
		...(model.supportsCaching !== undefined ? { supportsCaching: model.supportsCaching } : {}),
	}));
}
