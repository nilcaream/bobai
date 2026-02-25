import fs from "node:fs";
import path from "node:path";

export interface AuthEntry {
	token: string;
}

export interface GlobalPreferences {
	provider?: string;
	model?: string;
}

export interface GlobalConfig {
	auth: Record<string, AuthEntry>;
	preferences: GlobalPreferences;
}

export function loadGlobalConfig(configDir: string): GlobalConfig {
	const auth = readJson<Record<string, AuthEntry>>(path.join(configDir, "auth.json")) ?? {};
	const preferences = readJson<GlobalPreferences>(path.join(configDir, "bobai.json")) ?? {};
	return { auth, preferences };
}

function readJson<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
