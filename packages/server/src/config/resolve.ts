import { DEFAULT_PROVIDER_ID, getDefaultModelForProvider } from "../provider/providers";

export interface ResolvedConfig {
	provider: string;
	model: string;
	maxIterations?: number;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
	maxIterations?: number;
}

const DEFAULTS: ResolvedConfig = {
	provider: DEFAULT_PROVIDER_ID,
	model: getDefaultModelForProvider(DEFAULT_PROVIDER_ID),
};

export function resolveConfig(project: ConfigLayer, global: ConfigLayer): ResolvedConfig {
	return {
		provider: project.provider ?? global.provider ?? DEFAULTS.provider,
		model: project.model ?? global.model ?? DEFAULTS.model,
		maxIterations: project.maxIterations ?? global.maxIterations,
	};
}
