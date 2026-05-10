export type PlatformId = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64-wsl" | "win32-x64-native";

export interface PlatformInfo {
	id: PlatformId;
	os: "linux" | "darwin" | "win32";
	arch: "x64" | "arm64";
	variant?: "wsl" | "native";
}

export interface PlatformPaths {
	/** Config files: auth.json, bobai.json, models.json, skills/, plugins/, instructions. */
	configDir: string;
	/** Runtime data: Bun binary, dist/, project databases. */
	dataDir: string;
	/** Transient cache: downloads, compaction artifacts. */
	cacheDir: string;
	/** Rotated log files. */
	logDir: string;
	/** Temporary files. */
	tempDir: string;
	/** Where the runner script/binary is installed. */
	binDir: string;
}

export type ShellToolKind = "bash" | "cmd" | "powershell";

export type GrepToolKind = "grep_search" | "findstr";

export interface AvailableTools {
	shells: ShellToolKind[];
	grepTools: GrepToolKind[];
	git: boolean;
}
