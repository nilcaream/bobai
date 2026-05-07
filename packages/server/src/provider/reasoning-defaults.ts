import type { ProviderOptions } from "./provider";

export const DEFAULT_REASONING_DEFAULTS: NonNullable<ProviderOptions["reasoningDefaults"]> = {
	anthropic: {
		budgetTokens: 1024,
		display: "omitted",
	},
};
