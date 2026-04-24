export interface OpenCodeZenModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	label: string;
	enabled: boolean;
}

export const CURATED_OPENCODE_ZEN_MODELS: OpenCodeZenModelConfig[] = [
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-opus-4-5", name: "Claude Opus 4.5", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 128000, maxOutput: 64000, label: "beta", enabled: true },
	{ id: "glm-5.1", name: "GLM 5.1", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "glm-5", name: "GLM 5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "minimax-m2.7", name: "MiniMax M2.7", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "qwen3.6-plus", name: "Qwen3.6 Plus", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "qwen3.5-plus", name: "Qwen3.5 Plus", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "big-pickle", name: "Big Pickle", contextWindow: 131072, maxOutput: 16384, label: "beta", enabled: true },
	{ id: "minimax-m2.5-free", name: "MiniMax M2.5 Free", contextWindow: 131072, maxOutput: 16384, label: "free", enabled: true },
	{ id: "hy3-preview-free", name: "Hy3 Preview Free", contextWindow: 131072, maxOutput: 16384, label: "free", enabled: true },
	{
		id: "ling-2.6-flash-free",
		name: "Ling 2.6 Flash Free",
		contextWindow: 131072,
		maxOutput: 16384,
		label: "free",
		enabled: true,
	},
	{
		id: "trinity-large-preview-free",
		name: "Trinity Large Preview Free",
		contextWindow: 131072,
		maxOutput: 16384,
		label: "free",
		enabled: true,
	},
	{
		id: "nemotron-3-super-free",
		name: "Nemotron 3 Super Free",
		contextWindow: 131072,
		maxOutput: 16384,
		label: "free",
		enabled: true,
	},
];

export function loadOpenCodeZenModelsConfig(): OpenCodeZenModelConfig[] {
	return CURATED_OPENCODE_ZEN_MODELS;
}
