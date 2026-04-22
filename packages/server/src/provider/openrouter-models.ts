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
		id: "google/gemini-2.5-flash",
		name: "Google Gemini 2.5 Flash",
		contextWindow: 1000000,
		maxOutput: 64000,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "google/gemma-3-27b-it:free",
		name: "Google Gemma 3 27B IT (Free)",
		contextWindow: 131072,
		maxOutput: 8192,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "meta-llama/llama-3.3-8b-instruct:free",
		name: "Meta Llama 3.3 8B Instruct (Free)",
		contextWindow: 131072,
		maxOutput: 8192,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "mistralai/mistral-small-3.1-24b-instruct:free",
		name: "Mistral Small 3.1 24B Instruct (Free)",
		contextWindow: 128000,
		maxOutput: 8192,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
	{
		id: "openai/gpt-5",
		name: "OpenAI GPT-5",
		contextWindow: 400000,
		maxOutput: 128000,
		label: "$1.25 | $10.00",
		inputPrice: 1.25,
		outputPrice: 10,
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
	{
		id: "qwen/qwen-2.5-7b-instruct:free",
		name: "Qwen 2.5 7B Instruct (Free)",
		contextWindow: 131072,
		maxOutput: 8192,
		label: "free",
		inputPrice: 0,
		outputPrice: 0,
		enabled: true,
	},
];

export function loadOpenRouterModelsConfig(): OpenRouterModelConfig[] {
	return CURATED_OPENROUTER_MODELS;
}
