import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateGlobalConfig, updateProjectConfig } from "../src/config/write";

describe("updateProjectConfig", () => {
	let projectRoot: string;
	let bobaiDir: string;
	let configPath: string;

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-write-project-"));
		bobaiDir = path.join(projectRoot, ".bobai");
		fs.mkdirSync(bobaiDir, { recursive: true });
		configPath = path.join(bobaiDir, "bobai.json");
	});

	afterEach(() => {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("creates config file with the update when file does not exist", () => {
		const result = updateProjectConfig(projectRoot, { debug: true });

		expect(result.debug).toBe(true);
		expect(fs.existsSync(configPath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		expect(raw.debug).toBe(true);
	});

	test("merges update with existing config preserving other fields", () => {
		fs.writeFileSync(configPath, JSON.stringify({ id: "abc-123", port: 3000 }));

		const result = updateProjectConfig(projectRoot, { debug: true });

		expect(result.id).toBe("abc-123");
		expect(result.port).toBe(3000);
		expect(result.debug).toBe(true);
	});

	test("preserves unknown fields in existing config", () => {
		fs.writeFileSync(configPath, JSON.stringify({ id: "abc-123", customTheme: "dark", futureFlag: true }));

		updateProjectConfig(projectRoot, { debug: true });

		// Unknown fields should survive the write
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		expect(raw.customTheme).toBe("dark");
		expect(raw.futureFlag).toBe(true);

		// Known fields should be updated
		expect(raw.debug).toBe(true);
		expect(raw.id).toBe("abc-123");
	});

	test("rejects changes to the id field", () => {
		fs.writeFileSync(configPath, JSON.stringify({ id: "abc-123" }));

		expect(() => updateProjectConfig(projectRoot, { id: "new-id" })).toThrow("The project id field cannot be changed");
	});
});

describe("updateGlobalConfig", () => {
	let configDir: string;
	let configPath: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-write-global-"));
		configPath = path.join(configDir, "bobai.json");
	});

	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("creates config file with the update when file does not exist", () => {
		const result = updateGlobalConfig(configDir, { debug: true });

		expect(result.debug).toBe(true);
		expect(fs.existsSync(configPath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		expect(raw.debug).toBe(true);
	});

	test("merges update with existing config preserving other fields", () => {
		fs.writeFileSync(configPath, JSON.stringify({ provider: "github-copilot", port: 8080 }));

		const result = updateGlobalConfig(configDir, { debug: false });

		expect(result.provider).toBe("github-copilot");
		expect(result.port).toBe(8080);
		expect(result.debug).toBe(false);
	});

	test("preserves unknown fields in existing config", () => {
		fs.writeFileSync(configPath, JSON.stringify({ provider: "gh", customKey: "value" }));

		updateGlobalConfig(configDir, { maxIterations: 100 });

		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
		expect(raw.customKey).toBe("value");
		expect(raw.maxIterations).toBe(100);
	});

	test("does not reject id changes (global config has no id concept)", () => {
		fs.writeFileSync(configPath, JSON.stringify({ someField: "value" }));

		// Should not throw — global config doesn't have an immutable id
		const result = updateGlobalConfig(configDir, { port: 8080 } as Partial<import("../src/config/global").GlobalPreferences>);
		expect(result.port).toBe(8080);
	});
});
