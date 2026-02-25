export interface ResolvedConfig {
	provider: string;
	model: string;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
}

const DEFAULTS: ResolvedConfig = {
	provider: "github-copilot",
	model: "gpt-5-mini",
};

export function resolveConfig(project: ConfigLayer, global: ConfigLayer): ResolvedConfig {
	return {
		provider: project.provider ?? global.provider ?? DEFAULTS.provider,
		model: project.model ?? global.model ?? DEFAULTS.model,
	};
}
