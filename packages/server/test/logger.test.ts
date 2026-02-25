import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/log/logger";

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
		expect(content).toContain("INFO  TEST hello world");
	});

	test("formats line as timestamp level system message", () => {
		const logger = createLogger({ level: "debug", logDir: tmpDir });
		logger.warn("AUTH", "token expired");

		const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
		const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
		expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} WARN {2}AUTH token expired\n$/);
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
});
