import fs from "node:fs";
import path from "node:path";
import type { AvailableTools, GrepToolKind, PlatformInfo, ShellToolKind } from "./types";

interface ShellCandidate {
	kind: ShellToolKind;
	/** Absolute known path, or executable name to resolve via PATH. */
	resolve: string;
	/** If true, check existence via fs.statSync at the resolved path. Otherwise use PATH lookup. */
	knownPath: boolean;
}

interface GrepCandidate {
	kind: GrepToolKind;
	resolve: string;
	knownPath: boolean;
}

function systemRoot(): string {
	return process.env.SystemRoot ?? "C:\\Windows";
}

function getShellCandidates(info: PlatformInfo): ShellCandidate[] {
	// Linux, macOS, WSL: bash at /bin/bash
	if (info.os !== "win32" || info.variant === "wsl") {
		return [{ kind: "bash", resolve: "/bin/bash", knownPath: true }];
	}

	// Windows native: cmd.exe always at System32, powershell on PATH
	return [
		{ kind: "cmd", resolve: path.join(systemRoot(), "System32", "cmd.exe"), knownPath: true },
		{ kind: "powershell", resolve: "powershell.exe", knownPath: false },
	];
}

function getGrepCandidates(info: PlatformInfo): GrepCandidate[] {
	// Linux, macOS, WSL: grep on PATH
	if (info.os !== "win32" || info.variant === "wsl") {
		return [{ kind: "grep_search", resolve: "grep", knownPath: false }];
	}

	// Windows native: findstr.exe always at System32
	return [{ kind: "findstr", resolve: path.join(systemRoot(), "System32", "findstr.exe"), knownPath: true }];
}

/**
 * Check whether a command exists.
 *
 * For known paths: stat the file directly.
 * For PATH lookups: use the platform-appropriate resolver
 *   (command -v on Unix, where on Windows).
 */
async function commandExists(resolve: string, knownPath: boolean, isUnix: boolean): Promise<boolean> {
	if (knownPath) {
		try {
			fs.statSync(resolve);
			return true;
		} catch {
			return false;
		}
	}

	if (isUnix) {
		return commandExistsViaShell(resolve);
	}
	return commandExistsViaWhere(resolve);
}

async function commandExistsViaShell(name: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["sh", "-c", `command -v "${name}"`], {
			stdout: "null",
			stderr: "null",
		});
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

async function commandExistsViaWhere(name: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["where", name], {
			stdout: "null",
			stderr: "null",
		});
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

export async function detectAvailableTools(info: PlatformInfo): Promise<AvailableTools> {
	const isUnix = info.os !== "win32" || info.variant === "wsl";

	const shellCandidates = getShellCandidates(info);
	const grepCandidates = getGrepCandidates(info);

	const [shellResults, grepResults, gitResult] = await Promise.all([
		Promise.all(
			shellCandidates.map(async (c) => ({
				kind: c.kind,
				available: await commandExists(c.resolve, c.knownPath, isUnix),
			})),
		),
		Promise.all(
			grepCandidates.map(async (c) => ({
				kind: c.kind,
				available: await commandExists(c.resolve, c.knownPath, isUnix),
			})),
		),
		isUnix ? commandExistsViaShell("git") : commandExistsViaWhere("git"),
	]);

	return {
		shells: shellResults.filter((r) => r.available).map((r) => r.kind),
		grepTools: grepResults.filter((r) => r.available).map((r) => r.kind),
		git: gitResult,
	};
}
