export interface OpenRouterModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	label: string;
	inputPrice?: number;
	outputPrice?: number;
	enabled: boolean;
}

export const CURATED_OPENROUTER_MODELS: OpenRouterModelConfig[] = [
	{
		id: "openrouter/free",
		name: "OpenRouter Free Router",
		contextWindow: 200000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "tencent/hy3-preview:free",
		name: "Tencent Hy3 Preview (Free)",
		contextWindow: 262000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		name: "NVIDIA Nemotron 3 Super (Free)",
		contextWindow: 262000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "openai/gpt-oss-120b:free",
		name: "OpenAI gpt-oss-120b (Free)",
		contextWindow: 131000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "google/gemma-4-31b-it:free",
		name: "Google Gemma 4 31B (Free)",
		contextWindow: 262000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "openai/gpt-oss-20b:free",
		name: "OpenAI gpt-oss-20b (Free)",
		contextWindow: 131000,
		maxOutput: 16384,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "anthropic/claude-haiku-4.5",
		name: "Anthropic Claude Haiku 4.5",
		contextWindow: 128000,
		maxOutput: 64000,
		label: "$0.50 | $5.12",
		inputPrice: 0.5,
		outputPrice: 5.12,
		enabled: true,
	},
	{
		id: "anthropic/claude-sonnet-4",
		name: "Anthropic Claude Sonnet 4",
		contextWindow: 200000,
		maxOutput: 64000,
		label: "$3.00 | $15.00",
		inputPrice: 3,
		outputPrice: 15,
		enabled: true,
	},
	{
		id: "openai/gpt-5-mini",
		name: "OpenAI GPT-5 Mini",
		contextWindow: 400000,
		maxOutput: 128000,
		label: "$0.25 | $2.00",
		inputPrice: 0.25,
		outputPrice: 2,
		enabled: true,
	},
];

export function loadOpenRouterModelsConfig(): OpenRouterModelConfig[] {
	return CURATED_OPENROUTER_MODELS;
}
