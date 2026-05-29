import fs from "node:fs";
import path from "node:path";
import type { BobaiConfig } from "../project";
import type { GlobalPreferences } from "./global";

export function updateProjectConfig(projectRoot: string, update: Partial<BobaiConfig>): BobaiConfig {
	const bobaiDir = path.join(projectRoot, ".bobai");
	const configPath = path.join(bobaiDir, "bobai.json");

	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		fs.mkdirSync(bobaiDir, { recursive: true });
	}

	// Reject attempts to change the project id
	if (update.id !== undefined && existing.id !== undefined && update.id !== existing.id) {
		throw new Error("The project id field cannot be changed");
	}

	const merged = { ...existing, ...update };
	fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
	return merged as BobaiConfig;
}

export function updateGlobalConfig(configDir: string, update: Partial<GlobalPreferences>): GlobalPreferences {
	const configPath = path.join(configDir, "bobai.json");

	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		fs.mkdirSync(configDir, { recursive: true });
	}

	const merged = { ...existing, ...update };
	fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
	return merged as GlobalPreferences;
}
