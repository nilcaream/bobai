import fs from "node:fs";
import path from "node:path";

export interface GlobalPreferences {
	provider?: string;
	model?: string;
	maxIterations?: number;
	debug?: boolean;
	port?: number;
}

export interface GlobalConfig {
	preferences: GlobalPreferences;
	filePath: string;
}

export function loadGlobalConfig(configDir: string): GlobalConfig {
	const filePath = path.join(configDir, "bobai.json");
	const preferences = readJson<GlobalPreferences>(filePath) ?? {};
	return { preferences, filePath };
}

function readJson<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
