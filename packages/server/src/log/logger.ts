import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	readonly level: LogLevel;
	readonly logDir: string;
	debug(system: string, message: string): void;
	info(system: string, message: string): void;
	warn(system: string, message: string): void;
	error(system: string, message: string): void;
	withSession(tag: string): Logger;
}

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const sessionTagStore = new AsyncLocalStorage<string>();

export function runWithSessionTag<T>(tag: string, fn: () => T): T {
	return sessionTagStore.run(tag, fn);
}

export function getSessionTag(): string | undefined {
	return sessionTagStore.getStore();
}

export function localTimestamp(): string {
	return new Date(Date.now() - new Date().getTimezoneOffset() * 60 * 1000).toISOString().replace(/[TZ]/g, " ").trim();
}

export function createLogger(options: { level: LogLevel; logDir: string }): Logger {
	const threshold = LEVELS[options.level];
	let dirCreated = false;

	function ensureDir(): void {
		if (dirCreated) return;
		try {
			fs.mkdirSync(options.logDir, { recursive: true });
			dirCreated = true;
		} catch {
			// best effort
		}
	}

	function write(level: LogLevel, system: string, message: string, sessionTag?: string): void {
		if (LEVELS[level] < threshold) return;
		ensureDir();
		const tag = sessionTag ?? getSessionTag() ?? "main";
		const ts = localTimestamp();
		const date = ts.slice(0, 10);
		const filePath = path.join(options.logDir, `${date}.log`);
		const line = `${ts} ${level.toUpperCase().padEnd(5)} ${system} ${tag} ${message}`;
		try {
			fs.appendFileSync(filePath, `${line}\n`);
		} catch {
			process.stderr.write(`[log] ${line}\n`);
		}
	}

	function makeLogger(sessionTag?: string): Logger {
		return {
			level: options.level,
			logDir: options.logDir,
			debug: (system, message) => write("debug", system, message, sessionTag),
			info: (system, message) => write("info", system, message, sessionTag),
			warn: (system, message) => write("warn", system, message, sessionTag),
			error: (system, message) => write("error", system, message, sessionTag),
			withSession: (tag: string) => makeLogger(tag),
		};
	}

	return makeLogger();
}
