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
	withScope(scope: string): Logger;
}

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const scopeStore = new AsyncLocalStorage<string>();

export function runWithScope<T>(scope: string, fn: () => T): T {
	return scopeStore.run(scope, fn);
}

export function getScope(): string | undefined {
	return scopeStore.getStore();
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

	function write(level: LogLevel, system: string, message: string, scope?: string): void {
		if (LEVELS[level] < threshold) return;
		ensureDir();
		const scope_ = scope ?? getScope() ?? "global";
		const ts = localTimestamp();
		const date = ts.slice(0, 10);
		const filePath = path.join(options.logDir, `${date}.log`);
		const line = `${ts} ${level.toUpperCase()} ${system} ${scope_} ${message}`;
		try {
			fs.appendFileSync(filePath, `${line}\n`);
		} catch {
			process.stderr.write(`[log] ${line}\n`);
		}
	}

	function makeLogger(scope?: string): Logger {
		return {
			level: options.level,
			logDir: options.logDir,
			debug: (system, message) => write("debug", system, message, scope),
			info: (system, message) => write("info", system, message, scope),
			warn: (system, message) => write("warn", system, message, scope),
			error: (system, message) => write("error", system, message, scope),
			withScope: (scope: string) => makeLogger(scope),
		};
	}

	return makeLogger();
}
