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
 * For PATH lookups: use Bun.which (native, cross-platform, no shell required).
 */
async function commandExists(resolve: string, knownPath: boolean): Promise<boolean> {
	if (knownPath) {
		try {
			fs.statSync(resolve);
			return true;
		} catch {
			return false;
		}
	}

	return Bun.which(resolve) !== null;
}

export async function detectAvailableTools(info: PlatformInfo): Promise<AvailableTools> {
	const shellCandidates = getShellCandidates(info);
	const grepCandidates = getGrepCandidates(info);

	const [shellResults, grepResults, gitAvailable] = await Promise.all([
		Promise.all(
			shellCandidates.map(async (c) => ({
				kind: c.kind,
				available: await commandExists(c.resolve, c.knownPath),
			})),
		),
		Promise.all(
			grepCandidates.map(async (c) => ({
				kind: c.kind,
				available: await commandExists(c.resolve, c.knownPath),
			})),
		),
		commandExists("git", false),
	]);

	return {
		shells: shellResults.filter((r) => r.available).map((r) => r.kind),
		grepTools: grepResults.filter((r) => r.available).map((r) => r.kind),
		git: gitAvailable,
	};
}
