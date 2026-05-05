import { exchangeToken } from "../provider/copilot";
import { AMAZON_BEDROCK_DEFAULT_REGION, validateAmazonBedrockKey } from "./amazon-bedrock";
import { pollForToken, requestDeviceCode } from "./device-flow";
import { validateOpenCodeGoKey } from "./opencode-go";
import { validateOpenCodeZenKey } from "./opencode-zen";
import { validateOpenRouterKey } from "./openrouter";
import { promptSecret } from "./prompt-secret";
import {
	type AuthProviderId,
	type AuthStore,
	type CopilotAuth,
	loadAuthStore,
	saveAuthStore,
	setAmazonBedrockAuth,
	setCopilotAuth,
	setOpenCodeGoAuth,
	setOpenCodeZenAuth,
	setOpenRouterAuth,
} from "./store";

export async function authorizeCopilot(configDir: string): Promise<CopilotAuth> {
	console.log("Authenticating with GitHub Copilot");

	const deviceCode = await requestDeviceCode();

	console.log(`- Open: ${deviceCode.verification_uri}`);
	console.log(`- Enter code: ${deviceCode.user_code}`);

	console.log("");
	console.log("Waiting for authorization");

	const githubToken = await pollForToken(deviceCode.device_code, deviceCode.interval);
	console.log("- GitHub OAuth complete");

	console.log("");
	console.log("Exchanging token for Copilot session");
	const session = await exchangeToken(githubToken);
	console.log("- Session obtained");
	console.log("");

	const auth: CopilotAuth = { refresh: githubToken, access: session.access, expires: session.expires };
	const store: AuthStore = loadAuthStore(configDir) ?? { version: 1, providers: {} };
	saveAuthStore(configDir, setCopilotAuth(store, auth));

	return auth;
}

async function authorizeApiKeyProvider(
	configDir: string,
	options: {
		prompt: string;
		readSecret: (prompt: string) => Promise<string>;
		validateKey: (apiKey: string) => Promise<void>;
		setAuth: (store: AuthStore, auth: { apiKey: string }) => AuthStore;
		successMessage: string;
	},
): Promise<void> {
	const apiKey = await options.readSecret(options.prompt);
	await options.validateKey(apiKey);
	const store: AuthStore = loadAuthStore(configDir) ?? { version: 1, providers: {} };
	saveAuthStore(configDir, options.setAuth(store, { apiKey }));
	console.log(options.successMessage);
}

export async function authorizeOpenRouter(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		validateOpenRouterKey?: (apiKey: string) => Promise<void>;
	} = {},
): Promise<void> {
	await authorizeApiKeyProvider(configDir, {
		prompt: "Paste OpenRouter API key: ",
		readSecret: deps.promptSecret ?? promptSecret,
		validateKey: deps.validateOpenRouterKey ?? validateOpenRouterKey,
		setAuth: setOpenRouterAuth,
		successMessage: "OpenRouter key saved",
	});
}

export async function authorizeOpenCodeGo(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		validateOpenCodeGoKey?: (apiKey: string) => Promise<void>;
	} = {},
): Promise<void> {
	await authorizeApiKeyProvider(configDir, {
		prompt: "Paste OpenCode Go API key: ",
		readSecret: deps.promptSecret ?? promptSecret,
		validateKey: deps.validateOpenCodeGoKey ?? validateOpenCodeGoKey,
		setAuth: setOpenCodeGoAuth,
		successMessage: "OpenCode Go key saved",
	});
}

export async function authorizeOpenCodeZen(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		validateOpenCodeZenKey?: (apiKey: string) => Promise<void>;
	} = {},
): Promise<void> {
	await authorizeApiKeyProvider(configDir, {
		prompt: "Paste OpenCode Zen API key: ",
		readSecret: deps.promptSecret ?? promptSecret,
		validateKey: deps.validateOpenCodeZenKey ?? validateOpenCodeZenKey,
		setAuth: setOpenCodeZenAuth,
		successMessage: "OpenCode Zen key saved",
	});
}

export async function authorizeAmazonBedrock(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		promptRegion?: (prompt: string) => Promise<string>;
		validateAmazonBedrockKey?: (apiKey: string, region: string) => Promise<void>;
	} = {},
): Promise<void> {
	const readSecret = deps.promptSecret ?? promptSecret;
	const readRegion = deps.promptRegion ?? promptSecret; // reuse promptSecret for plain text input
	const validate = deps.validateAmazonBedrockKey ?? validateAmazonBedrockKey;

	const apiKey = await readSecret("Paste Amazon Bedrock bearer token: ");
	const regionInput = await readRegion(`AWS Region [${AMAZON_BEDROCK_DEFAULT_REGION}]: `);
	const region = regionInput.trim() || AMAZON_BEDROCK_DEFAULT_REGION;

	await validate(apiKey, region);

	const store: AuthStore = loadAuthStore(configDir) ?? { version: 1, providers: {} };
	saveAuthStore(configDir, setAmazonBedrockAuth(store, { apiKey, region }));
	console.log("Amazon Bedrock bearer token saved");
}

export interface AuthProviderEntry {
	id: AuthProviderId;
	authorize(configDir: string): Promise<void>;
}

const AUTH_PROVIDERS: AuthProviderEntry[] = [
	{
		id: "github-copilot",
		authorize: async (configDir: string) => {
			await authorizeCopilot(configDir);
		},
	},
	{
		id: "openrouter",
		authorize: async (configDir: string) => {
			await authorizeOpenRouter(configDir);
		},
	},
	{
		id: "opencode-go",
		authorize: async (configDir: string) => {
			await authorizeOpenCodeGo(configDir);
		},
	},
	{
		id: "opencode-zen",
		authorize: async (configDir: string) => {
			await authorizeOpenCodeZen(configDir);
		},
	},
	{
		id: "amazon-bedrock",
		authorize: async (configDir: string) => {
			await authorizeAmazonBedrock(configDir);
		},
	},
];

export function listSupportedAuthProviders(): AuthProviderEntry[] {
	return AUTH_PROVIDERS;
}

export function getAuthProvider(providerId: AuthProviderId): AuthProviderEntry | undefined {
	return AUTH_PROVIDERS.find((provider) => provider.id === providerId);
}

export const authorize = authorizeCopilot;
