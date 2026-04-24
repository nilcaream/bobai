export interface OpenCodeGoModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	label: string;
	enabled: boolean;
}

export const CURATED_OPENCODE_GO_MODELS: OpenCodeGoModelConfig[] = [
	{ id: "glm-5.1", name: "GLM 5.1", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "glm-5", name: "GLM 5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "qwen3.6-plus", name: "Qwen3.6 Plus", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "qwen3.5-plus", name: "Qwen3.5 Plus", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "mimo-v2-pro", name: "MiMo V2 Pro", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "mimo-v2-omni", name: "MiMo V2 Omni", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "mimo-v2.5", name: "MiMo V2.5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "minimax-m2.7", name: "MiniMax M2.7", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
];

export function loadOpenCodeGoModelsConfig(): OpenCodeGoModelConfig[] {
	return CURATED_OPENCODE_GO_MODELS;
}
