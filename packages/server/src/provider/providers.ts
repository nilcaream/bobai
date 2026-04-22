export const SUPPORTED_RUNTIME_PROVIDERS = ["github-copilot", "openrouter"] as const;
export const SUPPORTED_AUTH_PROVIDERS = ["github-copilot", "openrouter"] as const;
export const DEFAULT_PROVIDER_ID = "github-copilot";

export type ProviderId = (typeof SUPPORTED_RUNTIME_PROVIDERS)[number];
export type AuthProviderId = (typeof SUPPORTED_AUTH_PROVIDERS)[number];

export function isSupportedProvider(value: string): value is ProviderId {
	return SUPPORTED_RUNTIME_PROVIDERS.includes(value as ProviderId);
}

export function isSupportedAuthProvider(value: string): value is AuthProviderId {
	return SUPPORTED_AUTH_PROVIDERS.includes(value as AuthProviderId);
}

export function getDefaultModelForProvider(providerId: ProviderId): string {
	switch (providerId) {
		case "github-copilot":
			return "gpt-5-mini";
		case "openrouter":
			return "google/gemma-3-27b-it:free";
	}
}
