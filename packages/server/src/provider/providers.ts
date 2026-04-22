import {
	type AuthProviderId,
	DEFAULT_PROVIDER_ID,
	getProviderDescriptor,
	type ProviderId,
	SUPPORTED_AUTH_PROVIDER_IDS,
	SUPPORTED_RUNTIME_PROVIDER_IDS,
} from "./registry";

export { DEFAULT_PROVIDER_ID };
export type { ProviderId, AuthProviderId };

export const SUPPORTED_RUNTIME_PROVIDERS = SUPPORTED_RUNTIME_PROVIDER_IDS;
export const SUPPORTED_AUTH_PROVIDERS = SUPPORTED_AUTH_PROVIDER_IDS;

export function isSupportedProvider(value: string): value is ProviderId {
	return getProviderDescriptor(value) !== undefined;
}

export function isSupportedAuthProvider(value: string): value is AuthProviderId {
	return SUPPORTED_AUTH_PROVIDER_IDS.includes(value as AuthProviderId);
}

export function getDefaultModelForProvider(providerId: ProviderId): string {
	const descriptor = getProviderDescriptor(providerId);
	if (!descriptor) {
		throw new Error(`Unsupported provider: ${providerId}`);
	}
	return descriptor.defaultModel;
}
