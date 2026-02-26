import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalConfig } from "../src/config/global";

describe("loadGlobalConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-global-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns empty config when directory does not exist", () => {
		const config = loadGlobalConfig(path.join(tmpDir, "nonexistent"));
		expect(config).toEqual({ preferences: {} });
	});

	test("reads bobai.json preferences", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "bobai.json"), JSON.stringify({ provider: "github-copilot", model: "gpt-5-mini" }));
		const config = loadGlobalConfig(tmpDir);
		expect(config.preferences.provider).toBe("github-copilot");
		expect(config.preferences.model).toBe("gpt-5-mini");
	});

	test("returns empty preferences when files are missing", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		const config = loadGlobalConfig(tmpDir);
		expect(config.preferences).toEqual({});
	});

	test("reads headers from bobai.json", () => {
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "bobai.json"), JSON.stringify({ headers: { "User-Agent": "Custom/1.0" } }));
		const config = loadGlobalConfig(tmpDir);
		expect(config.preferences.headers).toEqual({ "User-Agent": "Custom/1.0" });
	});
});
