export const DEFAULT_PROVIDER_ID = "github-copilot";

export type ProviderId = typeof DEFAULT_PROVIDER_ID;

export function isSupportedProvider(value: string): value is ProviderId {
	return value === DEFAULT_PROVIDER_ID;
}

export function getDefaultModelForProvider(providerId: ProviderId): string {
	switch (providerId) {
		case "github-copilot":
			return "gpt-5-mini";
	}
}
