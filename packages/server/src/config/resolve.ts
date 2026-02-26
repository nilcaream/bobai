export interface ResolvedConfig {
	provider: string;
	model: string;
	headers: Record<string, string>;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
	headers?: Record<string, string>;
}

const DEFAULTS: ResolvedConfig = {
	provider: "github-copilot",
	model: "gpt-4o",
	headers: {},
};

export function resolveConfig(project: ConfigLayer, global: ConfigLayer): ResolvedConfig {
	return {
		provider: project.provider ?? global.provider ?? DEFAULTS.provider,
		model: project.model ?? global.model ?? DEFAULTS.model,
		headers: { ...DEFAULTS.headers, ...global.headers, ...project.headers },
	};
}
