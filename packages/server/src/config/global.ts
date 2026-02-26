import fs from "node:fs";
import path from "node:path";

export interface GlobalPreferences {
	provider?: string;
	model?: string;
	headers?: Record<string, string>;
}

export interface GlobalConfig {
	preferences: GlobalPreferences;
}

export function loadGlobalConfig(configDir: string): GlobalConfig {
	const preferences = readJson<GlobalPreferences>(path.join(configDir, "bobai.json")) ?? {};
	return { preferences };
}

function readJson<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
