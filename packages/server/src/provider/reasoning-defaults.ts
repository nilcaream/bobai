import type { ProviderOptions } from "./provider";

export const DEFAULT_REASONING_DEFAULTS: NonNullable<ProviderOptions["reasoningDefaults"]> = {
	anthropic: {
		// 16 KiB — Anthropic's documented starting point for complex agentic tasks
		// (multi-step planning, refactors). 1024 is the bare minimum for simple tasks.
		budgetTokens: 16384,
		display: "summarized",
	},
};
