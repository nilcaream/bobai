import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, runWithSessionTag } from "../src/log/logger";

describe("logger", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-log-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("creates log directory and writes daily file", () => {
		const logDir = path.join(tmpDir, "nested", "log");
		const logger = createLogger({ level: "debug", logDir });
		logger.info("TEST", "hello world");

		const files = fs.readdirSync(logDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);

		const content = fs.readFileSync(path.join(logDir, files[0]), "utf8");
		expect(content).toContain("INFO  TEST main hello world");
	});

	test("formats line as timestamp level system message", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.warn("AUTH", "token expired");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} WARN {2}AUTH main token expired\n$/);
	});

	test("filters messages below configured level", () => {
		const logger = createLogger({ level: "warn", logDir: tmpDir });
		logger.debug("X", "no");
		logger.info("X", "no");
		logger.warn("X", "yes");
		logger.error("X", "yes");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2);
		expect(content).toContain("WARN");
		expect(content).toContain("ERROR");
		expect(content).not.toContain("DEBUG");
		expect(content).not.toContain("INFO");
	});

	test("appends multiple messages to same file", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.info("A", "first");
		logger.info("B", "second");
		logger.debug("C", "third");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content.trim().split("\n").length).toBe(3);
	});

	test("withSession adds session tag to log line", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const scoped = logger.withSession("abcd1234");
		scoped.info("TEST", "hello");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toContain("INFO  TEST abcd1234 hello");
	});

	test("default logger uses 'main' as session tag", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.info("TEST", "startup");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toContain("INFO  TEST main startup");
	});

	test("withSession for subagent uses parent:child format", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const scoped = logger.withSession("aaa11111:bbb22222");
		scoped.warn("TASK", "subagent msg");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toContain("WARN  TASK aaa11111:bbb22222 subagent msg");
	});

	test("log line has fixed column count when split by space", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.info("SYS", "no session");
		logger.withSession("abcd1234").info("SYS", "with session");
		logger.withSession("abcd1234:efgh5678").info("SYS", "with subagent");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		const lines = content.trim().split("\n");
		for (const line of lines) {
			const parts = line.split(" ");
			expect(parts.length).toBeGreaterThanOrEqual(6);
			expect(["main", "abcd1234", "abcd1234:efgh5678"]).toContain(parts[5]);
		}
	});

	test("AsyncLocalStorage session tag is used by logger when no explicit session", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });

		runWithSessionTag("ctx12345", () => {
			logger.info("HTTP", "from async context");
		});

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toContain("INFO  HTTP ctx12345 from async context");
	});

	test("explicit withSession takes precedence over AsyncLocalStorage", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		const scoped = logger.withSession("explicit1");

		runWithSessionTag("fromctx01", () => {
			scoped.info("TEST", "precedence check");
		});

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toContain("INFO  TEST explicit1 precedence check");
	});
});
