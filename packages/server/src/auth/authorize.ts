import { exchangeToken } from "../provider/copilot";
import { pollForToken, requestDeviceCode } from "./device-flow";
import { validateOpenCodeGoKey } from "./opencode-go";
import { validateOpenRouterKey } from "./openrouter";
import { promptSecret } from "./prompt-secret";
import {
	type AuthProviderId,
	type AuthStore,
	type CopilotAuth,
	loadAuthStore,
	saveAuthStore,
	setCopilotAuth,
	setOpenCodeGoAuth,
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

export async function authorizeOpenRouter(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		validateOpenRouterKey?: (apiKey: string) => Promise<void>;
	} = {},
): Promise<void> {
	const readSecret = deps.promptSecret ?? promptSecret;
	const checkKey = deps.validateOpenRouterKey ?? validateOpenRouterKey;
	const apiKey = await readSecret("Paste OpenRouter API key: ");
	await checkKey(apiKey);
	const store: AuthStore = loadAuthStore(configDir) ?? { version: 1, providers: {} };
	saveAuthStore(configDir, setOpenRouterAuth(store, { apiKey }));
	console.log("OpenRouter key saved");
}

export async function authorizeOpenCodeGo(
	configDir: string,
	deps: {
		promptSecret?: (prompt: string) => Promise<string>;
		validateOpenCodeGoKey?: (apiKey: string) => Promise<void>;
	} = {},
): Promise<void> {
	const readSecret = deps.promptSecret ?? promptSecret;
	const checkKey = deps.validateOpenCodeGoKey ?? validateOpenCodeGoKey;
	const apiKey = await readSecret("Paste OpenCode Go API key: ");
	await checkKey(apiKey);
	const store: AuthStore = loadAuthStore(configDir) ?? { version: 1, providers: {} };
	saveAuthStore(configDir, setOpenCodeGoAuth(store, { apiKey }));
	console.log("OpenCode Go key saved");
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
];

export function listSupportedAuthProviders(): AuthProviderEntry[] {
	return AUTH_PROVIDERS;
}

export function getAuthProvider(providerId: AuthProviderId): AuthProviderEntry | undefined {
	return AUTH_PROVIDERS.find((provider) => provider.id === providerId);
}

export const authorize = authorizeCopilot;
