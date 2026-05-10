import os from "node:os";
import path from "node:path";
import type { PlatformId, PlatformInfo, PlatformPaths } from "./types";

const VALID_PLATFORM_IDS = new Set<string>([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64-wsl",
	"win32-x64-native",
]);

export function parsePlatformId(raw: string): PlatformInfo {
	if (!VALID_PLATFORM_IDS.has(raw)) {
		throw new Error(`Unknown BOBAI_PLATFORM "${raw}". Valid values: ${[...VALID_PLATFORM_IDS].sort().join(", ")}`);
	}

	const parts = raw.split("-");
	const os = parts[0] as PlatformInfo["os"];
	const arch = parts[1] as PlatformInfo["arch"];
	const variant = parts.length === 4 ? (parts[3] as PlatformInfo["variant"]) : undefined;

	return { id: raw as PlatformId, os, arch, variant };
}

function xdg(varName: string, fallback: string): string {
	return process.env[varName] || fallback;
}

function mustEnv(varName: string): string {
	const value = process.env[varName];
	if (!value) {
		throw new Error(`Required environment variable ${varName} is not set on this platform.`);
	}
	return value;
}

export class PlatformResolver {
	readonly info: PlatformInfo;
	readonly paths: PlatformPaths;

	constructor(info: PlatformInfo) {
		this.info = info;
		this.paths = this.resolvePaths();
	}

	private resolvePaths(): PlatformPaths {
		const home = os.homedir();

		// Linux and WSL share Linux filesystem conventions
		if (this.info.os === "linux" || this.info.variant === "wsl") {
			const configHome = xdg("XDG_CONFIG_HOME", path.join(home, ".config"));
			const dataHome = xdg("XDG_DATA_HOME", path.join(home, ".local", "share"));
			return {
				configDir: path.join(configHome, "bobai"),
				dataDir: path.join(dataHome, "bobai"),
				cacheDir: path.join(xdg("XDG_CACHE_HOME", path.join(home, ".cache")), "bobai"),
				logDir: path.join(dataHome, "bobai", "log"),
				tempDir: os.tmpdir(),
				binDir: path.join(home, ".local", "bin"),
			};
		}

		// macOS uses Apple-idiomatic paths under ~/Library
		if (this.info.os === "darwin") {
			return {
				configDir: path.join(home, "Library", "Application Support", "bobai"),
				dataDir: path.join(home, "Library", "Application Support", "bobai"),
				cacheDir: path.join(home, "Library", "Caches", "bobai"),
				logDir: path.join(home, "Library", "Logs", "bobai"),
				tempDir: os.tmpdir(),
				binDir: path.join(home, ".local", "bin"),
			};
		}

		// Windows native
		const appData = mustEnv("APPDATA");
		const localAppData = mustEnv("LOCALAPPDATA");
		return {
			configDir: path.join(appData, "bobai"),
			dataDir: path.join(localAppData, "bobai"),
			cacheDir: path.join(localAppData, "bobai", "Cache"),
			logDir: path.join(localAppData, "bobai", "Logs"),
			tempDir: process.env.TEMP ?? os.tmpdir(),
			binDir: path.join(localAppData, "bobai", "bin"),
		};
	}

	get skillsDir(): string {
		return path.join(this.paths.configDir, "skills");
	}

	get pluginsDir(): string {
		return path.join(this.paths.configDir, "plugins");
	}

	get instructionsDir(): string {
		return this.paths.configDir;
	}

	get modelCatalogPath(): string {
		return path.join(this.paths.configDir, "models.json");
	}

	get authPath(): string {
		return path.join(this.paths.configDir, "auth.json");
	}
}
