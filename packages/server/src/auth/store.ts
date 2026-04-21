import fs from "node:fs";
import path from "node:path";

export interface CopilotAuth {
	refresh: string;
	access: string;
	expires: number;
}

export interface OpenRouterAuth {
	apiKey: string;
}

export interface AuthStore {
	version: 1;
	providers: {
		"github-copilot"?: CopilotAuth;
		openrouter?: OpenRouterAuth;
	};
}

export function saveAuthStore(configDir: string, store: AuthStore): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(store, null, "\t"), { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

export function loadAuthStore(configDir: string): AuthStore | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AuthStore>;
		if (raw.version !== 1 || typeof raw.providers !== "object" || raw.providers === null) {
			return undefined;
		}
		return raw as AuthStore;
	} catch {
		return undefined;
	}
}

export function getCopilotAuth(store: AuthStore): CopilotAuth | undefined {
	return store.providers["github-copilot"];
}

export function getOpenRouterAuth(store: AuthStore): OpenRouterAuth | undefined {
	return store.providers.openrouter;
}

export function setCopilotAuth(store: AuthStore, auth: CopilotAuth): AuthStore {
	return {
		...store,
		providers: {
			...store.providers,
			"github-copilot": auth,
		},
	};
}

export function setOpenRouterAuth(store: AuthStore, auth: OpenRouterAuth): AuthStore {
	return {
		...store,
		providers: {
			...store.providers,
			openrouter: auth,
		},
	};
}
