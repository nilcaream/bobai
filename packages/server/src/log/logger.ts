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
}

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export function localTimestamp(): string {
	return new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60 * 1000).toISOString().replace(/[TZ]/g, " ").trim();
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

	function write(level: LogLevel, system: string, message: string): void {
		if (LEVELS[level] < threshold) return;
		ensureDir();
		const ts = localTimestamp();
		const date = ts.slice(0, 10);
		const filePath = path.join(options.logDir, `${date}.log`);
		const line = `${ts} ${level.toUpperCase().padEnd(5)} ${system} ${message}`;
		try {
			fs.appendFileSync(filePath, `${line}\n`);
		} catch {
			process.stderr.write(`[log] ${line}\n`);
		}
	}

	return {
		level: options.level,
		logDir: options.logDir,
		debug: (system, message) => write("debug", system, message),
		info: (system, message) => write("info", system, message),
		warn: (system, message) => write("warn", system, message),
		error: (system, message) => write("error", system, message),
	};
}
