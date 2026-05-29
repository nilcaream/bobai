import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/command";
import { createSession } from "../src/session/repository";
import { createTestDb } from "./helpers";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

function mockProviders(): { index: number; id: string; runtimeSupported: boolean }[] {
	return [
		{ index: 1, id: "github-copilot", runtimeSupported: true },
		{ index: 2, id: "openrouter", runtimeSupported: true },
		{ index: 3, id: "opencode-go", runtimeSupported: true },
	];
}

function makeOptions(overrides: Record<string, unknown> = {}) {
	return {
		configDir: overrides.configDir as string,
		projectRoot: overrides.projectRoot as string,
		projectConfig: overrides.projectConfig as Record<string, unknown>,
		globalConfig: overrides.globalConfig as Record<string, unknown>,
		listAuthenticatedProviders: mockProviders,
	};
}

describe("handleCommand configuration", () => {
	let db: Database;
	let projectRoot: string;
	let globalConfigDir: string;
	let projectConfig: Record<string, unknown>;
	let globalConfig: Record<string, unknown>;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-config-cmd-project-"));
		globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-config-cmd-global-"));

		// Set up project config
		const bobaiDir = path.join(projectRoot, ".bobai");
		fs.mkdirSync(bobaiDir, { recursive: true });
		projectConfig = { id: "test-project-id", debug: false, port: 3000 };
		fs.writeFileSync(path.join(bobaiDir, "bobai.json"), JSON.stringify(projectConfig));

		// Set up global config
		globalConfig = { provider: "github-copilot", maxIterations: 50 };
		fs.writeFileSync(path.join(globalConfigDir, "bobai.json"), JSON.stringify(globalConfig));

		// Set up model catalog
		writeUnifiedModelsConfig(globalConfigDir, {
			"github-copilot": createCopilotModels([
				{ id: "claude-haiku-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
				{ id: "claude-sonnet-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
			]),
		});
	});

	afterEach(() => {
		fs.rmSync(projectRoot, { recursive: true, force: true });
		fs.rmSync(globalConfigDir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Display tests
	// -----------------------------------------------------------------------

	test("bare .configuration shows effective config", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toBeDefined();
			const msg = result.messages?.[0];
			expect(msg?.kind).toBe("info");
			expect(msg?.text).toContain("debug = false");
			expect(msg?.text).toContain("port = 3000");
			expect(msg?.text).toContain("provider = github-copilot");
			expect(msg?.text).toContain("maxIterations = 50");
		}
	});

	test(".configuration project shows project config", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toContain("debug = false");
			expect(result.messages?.[0]?.text).toContain("port = 3000");
			expect(result.messages?.[0]?.text).not.toContain("id =");
		}
	});

	test(".configuration global shows global config", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "global", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toContain("provider = github-copilot");
			expect(result.messages?.[0]?.text).toContain("maxIterations = 50");
			expect(result.messages?.[0]?.text).toContain("debug = (not set)");
		}
	});

	test(".configuration project debug shows current debug value", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("debug = false");
		}
	});

	// -----------------------------------------------------------------------
	// Set tests
	// -----------------------------------------------------------------------

	test(".configuration project debug true sets debug", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug true", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.kind).toBe("success");
			expect(result.messages?.[0]?.text).toBe("project debug = true");
		}

		// Verify file was written
		const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, ".bobai", "bobai.json"), "utf8"));
		expect(raw.debug).toBe(true);
		// Existing fields preserved
		expect(raw.id).toBe("test-project-id");
		expect(raw.port).toBe(3000);
	});

	test(".configuration global port 8080 sets global port", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "global port 8080", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("global port = 8080");
		}

		const raw = JSON.parse(fs.readFileSync(path.join(globalConfigDir, "bobai.json"), "utf8"));
		expect(raw.port).toBe(8080);
		expect(raw.provider).toBe("github-copilot"); // preserved
	});

	test(".configuration project maxIterations 100 sets maxIterations", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project maxIterations 100", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("project maxIterations = 100");
		}

		const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, ".bobai", "bobai.json"), "utf8"));
		expect(raw.maxIterations).toBe(100);
	});

	test(".configuration global provider sets provider via exact name", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "global provider openrouter", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("global provider = openrouter");
		}

		const raw = JSON.parse(fs.readFileSync(path.join(globalConfigDir, "bobai.json"), "utf8"));
		expect(raw.provider).toBe("openrouter");
	});

	test(".configuration global provider sets provider via index", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "global provider 2", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("global provider = openrouter");
		}
	});

	// -----------------------------------------------------------------------
	// Abbreviation tests
	// -----------------------------------------------------------------------

	test("abbreviated scope works: g → global", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "g", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
	});

	test("abbreviated scope works: p → project", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "p", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
	});

	test("abbreviated field works: d → debug", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project d true", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("project debug = true");
		}
	});

	// -----------------------------------------------------------------------
	// Error tests
	// -----------------------------------------------------------------------

	test("unknown scope returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "xyz", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Unknown scope");
		}
	});

	test("unknown field returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project xyz", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Unknown field");
		}
	});

	test("invalid debug value returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug maybe", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Invalid value for debug");
		}
	});

	test("debug prefix 't' resolves to true", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug t", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("project debug = true");
		}
	});

	test("debug prefix 'fa' resolves to false", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug fa", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages?.[0]?.text).toBe("project debug = false");
		}
	});

	test("debug empty value after prefix returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		// This is the "field only — show current value" case, not an error
		expect(result.ok).toBe(true);
	});

	test("invalid port value returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project port 99999", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Invalid port");
		}
	});

	test("invalid maxIterations value returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project maxIterations 0", sessionId: session.id },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Invalid maxIterations");
		}
	});

	test("model validation fails when no provider configured", () => {
		const session = createSession(db);
		// No provider in project config, no provider in global config
		const noProviderGlobal = {};
		fs.writeFileSync(path.join(globalConfigDir, "bobai.json"), JSON.stringify(noProviderGlobal));

		const result = handleCommand(
			db,
			{ command: "configuration", args: "project model gpt-5", sessionId: session.id },
			makeOptions({
				configDir: globalConfigDir,
				projectRoot,
				projectConfig: { id: "x" },
				globalConfig: noProviderGlobal,
			}),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Set a provider");
		}
	});

	test(".configuration works without a session", () => {
		const result = handleCommand(
			db,
			{ command: "configuration", args: "project debug true" },
			makeOptions({ configDir: globalConfigDir, projectRoot, projectConfig, globalConfig }),
		);

		expect(result.ok).toBe(true);
	});
});
