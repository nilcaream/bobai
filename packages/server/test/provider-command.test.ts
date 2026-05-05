import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/command";
import { buildSortedProviderModelList } from "../src/provider/models";
import { appendMessage, createSession, getSession } from "../src/session/repository";
import { createTestDb } from "./helpers";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobai-provider-command-"));
}

describe("provider command", () => {
	test("provider command creates a session on demand and sets backend defaults", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{ id: "gpt-5-mini", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 0 },
				]),
			});
			const result = handleCommand(
				db,
				{ command: "provider", args: "1" },
				{
					defaultProviderId: "github-copilot",
					configDir: tmpDir,
					listAuthenticatedProviders: () => [{ index: 1, id: "github-copilot", runtimeSupported: true }],
				},
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const session = getSession(db, result.sessionId as string);
				expect(session?.provider).toBe("github-copilot");
				expect(session?.model).toBe("gpt-5-mini");
				expect(session?.apiFamily).toBe("openai-chat-completions");
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("provider command can select a provider for an empty session with no preselected backend", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		const session = createSession(db);
		try {
			writeUnifiedModelsConfig(tmpDir, {
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
			});
			const result = handleCommand(
				db,
				{ command: "provider", args: "1", sessionId: session.id },
				{
					defaultProviderId: null,
					defaultModel: null,
					configDir: tmpDir,
					listAuthenticatedProviders: () => [{ index: 1, id: "openrouter", runtimeSupported: true }],
				},
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const updated = getSession(db, session.id);
				expect(updated?.provider).toBe("openrouter");
				expect(updated?.model).toBe("openrouter/free");
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("provider switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{ id: "gpt-5-mini", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 0 },
				]),
			});
			const session = createSession(db, {
				provider: "github-copilot",
				model: "gpt-5-mini",
				apiFamily: "openai-chat-completions",
			});
			appendMessage(db, session.id, "user", "hello");
			const result = handleCommand(
				db,
				{ command: "provider", args: "1", sessionId: session.id },
				{
					defaultProviderId: "github-copilot",
					configDir: tmpDir,
					listAuthenticatedProviders: () => [{ index: 1, id: "github-copilot", runtimeSupported: true }],
				},
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("cross-family model switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{ id: "claude-haiku-4.5", contextWindow: 128000, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
					{ id: "gpt-5.2", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 1 },
				]),
			});
			const session = createSession(db, {
				provider: "github-copilot",
				model: "claude-haiku-4.5",
				apiFamily: "anthropic-messages",
			});
			appendMessage(db, session.id, "user", "hello");
			const models = buildSortedProviderModelList("github-copilot", tmpDir);
			const gpt52Index = models.findIndex((model) => model.id === "gpt-5.2") + 1;
			expect(gpt52Index).toBeGreaterThan(0);
			const result = handleCommand(
				db,
				{ command: "model", args: String(gpt52Index), sessionId: session.id },
				{ defaultProviderId: "github-copilot", configDir: tmpDir },
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("opencode-go cross-family model switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"opencode-go": [
					{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 131072, maxOutput: 16384, inputPrice: 0.5, outputPrice: 2 },
					{
						id: "minimax-m2.7",
						name: "MiniMax M2.7",
						contextWindow: 131072,
						maxOutput: 16384,
						inputPrice: 0.8,
						outputPrice: 3,
					},
				],
			});
			const session = createSession(db, {
				provider: "opencode-go",
				model: "kimi-k2.6",
				apiFamily: "openai-chat-completions",
			});
			appendMessage(db, session.id, "user", "hello");
			const models = buildSortedProviderModelList("opencode-go", tmpDir);
			const minimaxIndex = models.findIndex((model) => model.id === "minimax-m2.7") + 1;
			expect(minimaxIndex).toBeGreaterThan(0);
			const result = handleCommand(
				db,
				{ command: "model", args: String(minimaxIndex), sessionId: session.id },
				{ defaultProviderId: "github-copilot", configDir: tmpDir },
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("opencode-zen cross-family model switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"opencode-zen": [
					{
						id: "claude-sonnet-4-6",
						name: "Claude Sonnet 4.6",
						contextWindow: 200000,
						maxOutput: 64000,
						inputPrice: 3,
						outputPrice: 15,
					},
					{
						id: "qwen3.6-plus",
						name: "Qwen3.6 Plus",
						contextWindow: 131072,
						maxOutput: 16384,
						inputPrice: 0.3,
						outputPrice: 1.2,
					},
				],
			});
			const session = createSession(db, {
				provider: "opencode-zen",
				model: "claude-sonnet-4-6",
				apiFamily: "anthropic-messages",
			});
			appendMessage(db, session.id, "user", "hello");
			const models = buildSortedProviderModelList("opencode-zen", tmpDir);
			const qwenIndex = models.findIndex((model) => model.id === "qwen3.6-plus") + 1;
			expect(qwenIndex).toBeGreaterThan(0);
			const result = handleCommand(
				db,
				{ command: "model", args: String(qwenIndex), sessionId: session.id },
				{ defaultProviderId: "github-copilot", configDir: tmpDir },
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});

	test("opencode-zen gpt-to-chat cross-family model switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = makeTmpDir();
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"opencode-zen": [
					{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutput: 64000, inputPrice: 1, outputPrice: 4 },
					{
						id: "qwen3.6-plus",
						name: "Qwen3.6 Plus",
						contextWindow: 131072,
						maxOutput: 16384,
						inputPrice: 0.3,
						outputPrice: 1.2,
					},
				],
			});
			const session = createSession(db, {
				provider: "opencode-zen",
				model: "gpt-5.4",
				apiFamily: "openai-responses",
			});
			appendMessage(db, session.id, "user", "hello");
			const models = buildSortedProviderModelList("opencode-zen", tmpDir);
			const qwenIndex = models.findIndex((model) => model.id === "qwen3.6-plus") + 1;
			expect(qwenIndex).toBeGreaterThan(0);
			const result = handleCommand(
				db,
				{ command: "model", args: String(qwenIndex), sessionId: session.id },
				{ defaultProviderId: "github-copilot", configDir: tmpDir },
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});
});
