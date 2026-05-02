export interface ResolvedConfig {
	provider: string | null;
	model: string | null;
	maxIterations?: number;
}

interface ConfigLayer {
	provider?: string;
	model?: string;
	maxIterations?: number;
}

function resolveProviderModel(project: ConfigLayer, global: ConfigLayer): Pick<ResolvedConfig, "provider" | "model"> {
	if (project.provider && project.model) {
		return { provider: project.provider, model: project.model };
	}
	if (global.provider && global.model) {
		return { provider: global.provider, model: global.model };
	}
	return { provider: null, model: null };
}

export function resolveConfig(project: ConfigLayer, global: ConfigLayer): ResolvedConfig {
	return {
		...resolveProviderModel(project, global),
		maxIterations: project.maxIterations ?? global.maxIterations,
	};
}
