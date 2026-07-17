import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAuthStore } from "../src/auth/store";
import { resolveValidatedDefaultBackend } from "../src/config/default-backend";

describe("resolveValidatedDefaultBackend", () => {
	let tmpDir: string;
	let configDir: string;
	let projectFile: string;
	let globalFile: string;
	let errors: string[];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-default-backend-"));
		configDir = path.join(tmpDir, "config");
		fs.mkdirSync(configDir, { recursive: true });
		projectFile = path.join(tmpDir, "project.bobai.json");
		globalFile = path.join(tmpDir, "global.bobai.json");
		errors = [];
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function logger() {
		return {
			error(_system: string, message: string) {
				errors.push(message);
			},
		};
	}

	function writeModelsConfig() {
		fs.writeFileSync(
			path.join(configDir, "models.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-05T00:00:00.000Z",
				providers: {
					openrouter: [
						{
							id: "openrouter/free",
							name: "OpenRouter Free Router",
							contextWindow: 200000,
							maxOutput: 16384,
							inputPrice: 0,
							outputPrice: 0,
						},
					],
					"opencode-go": [],
					"opencode-zen": [],
				},
			}),
		);
	}

	test("returns null when neither project nor global defaults are configured", () => {
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile },
				global: { filePath: globalFile },
				configDir,
			},
			logger(),
		);
		expect(resolved).toBeNull();
		expect(errors).toEqual([]);
	});

	test("prefers a valid project backend over a valid global backend", () => {
		writeModelsConfig();
		saveAuthStore(configDir, {
			version: 1,
			providers: {
				openrouter: { apiKey: "key" },
			},
		});
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile, provider: "openrouter", model: "openrouter/free" },
				global: { filePath: globalFile, provider: "opencode-go", model: "deepseek-v4-flash" },
				configDir,
			},
			logger(),
		);
		expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free" });
		expect(errors).toEqual([]);
	});

	test("falls back to a valid global backend when project defaults are incomplete", () => {
		writeModelsConfig();
		saveAuthStore(configDir, {
			version: 1,
			providers: {
				openrouter: { apiKey: "key" },
			},
		});
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile, provider: "openrouter" },
				global: { filePath: globalFile, provider: "openrouter", model: "openrouter/free" },
				configDir,
			},
			logger(),
		);
		expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free" });
		expect(errors).toContain(`Provider/model defaults in ${projectFile} are incomplete`);
	});

	test("logs an invalid provider and falls back to global", () => {
		writeModelsConfig();
		saveAuthStore(configDir, {
			version: 1,
			providers: {
				openrouter: { apiKey: "key" },
			},
		});
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile, provider: "coppilot", model: "openrouter/free" },
				global: { filePath: globalFile, provider: "openrouter", model: "openrouter/free" },
				configDir,
			},
			logger(),
		);
		expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free" });
		expect(errors).toContain(`Provider coppilot in ${projectFile} is invalid`);
	});

	test("logs a missing authentication error and falls back to global", () => {
		writeModelsConfig();
		saveAuthStore(configDir, {
			version: 1,
			providers: {
				openrouter: { apiKey: "key" },
			},
		});
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile, provider: "opencode-go", model: "deepseek-v4-flash" },
				global: { filePath: globalFile, provider: "openrouter", model: "openrouter/free" },
				configDir,
			},
			logger(),
		);
		expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free" });
		expect(errors).toContain("No authentication details for provider opencode-go");
	});

	test("falls back to provider default when model is invalid", () => {
		writeModelsConfig();
		saveAuthStore(configDir, {
			version: 1,
			providers: {
				openrouter: { apiKey: "key" },
			},
		});
		const resolved = resolveValidatedDefaultBackend(
			{
				project: { filePath: projectFile, provider: "openrouter", model: "nonexistent/model" },
				global: { filePath: globalFile, provider: "openrouter", model: "another/bogus" },
				configDir,
			},
			logger(),
		);
		// Project layer: invalid model → falls back to provider default "openrouter/free"
		expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free" });
		expect(errors).toContain(`Model nonexistent/model in ${projectFile} is invalid, falling back to openrouter/free`);
	});
});
