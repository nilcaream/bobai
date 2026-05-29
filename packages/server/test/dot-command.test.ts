import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/command";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import type { ProviderId } from "../src/provider/providers";
import { createServer } from "../src/server";
import {
	appendMessage,
	createSession,
	createSubagentSession,
	getSession,
	updateSessionModel,
	updateSessionPromptTokens,
	updateSessionTitle,
} from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb } from "./helpers";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

describe("session model field", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("new session has null model", () => {
		const session = createSession(db);
		expect(session.model).toBeNull();
	});

	test("updateSessionModel sets the model", () => {
		const session = createSession(db);
		updateSessionModel(db, session.id, "claude-sonnet-4.6");
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe("claude-sonnet-4.6");
	});

	test("getSession returns model field", () => {
		const session = createSession(db);
		const fetched = getSession(db, session.id);
		expect(fetched).toHaveProperty("model");
		expect(fetched?.model).toBeNull();
	});
});

describe("session title update", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("updateSessionTitle sets the title", () => {
		const session = createSession(db);
		updateSessionTitle(db, session.id, "My Chat");
		const updated = getSession(db, session.id);
		expect(updated?.title).toBe("My Chat");
	});
});

describe("handleCommand", () => {
	let db: Database;
	let tmpDir: string;
	const providerId: ProviderId = "github-copilot";

	beforeAll(() => {
		db = createTestDb();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-test-"));
		writeUnifiedModelsConfig(tmpDir, {
			"github-copilot": createCopilotModels([
				{ id: "claude-haiku-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
				{ id: "claude-sonnet-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
				{ id: "gpt-5-mini", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 0 },
				{ id: "gpt-5.2", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
				{ id: "gpt-5.4", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
			]),
			openrouter: [
				{
					id: "anthropic/claude-haiku-4.5",
					name: "Anthropic Claude Haiku 4.5",
					contextWindow: 128000,
					maxOutput: 64000,
					inputPrice: 0.5,
					outputPrice: 5.12,
				},
				{
					id: "openrouter/free",
					name: "OpenRouter Free Router",
					contextWindow: 200000,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
			],
			"opencode-go": [
				{
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0.27,
					outputPrice: 1.1,
				},
			],
			"opencode-zen": [
				{
					id: "minimax-m2.5-free",
					name: "MiniMax M2.5 Free",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
				{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutput: 64000, inputPrice: 1, outputPrice: 4 },
			],
		});
	});

	afterAll(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("model command updates session model using id-sorted order and returns status", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const result = handleCommand(
			db,
			{ command: "model", args: "1", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toBe("github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 0 / 0 | 0%");
			expect(result.sessionId).toBe(session.id);
			expect(result.provider).toBe("github-copilot");
			expect(result.model).toBe("claude-haiku-4.5");
		}
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe("claude-haiku-4.5");
	});

	test("model command rejects invalid index", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const result = handleCommand(
			db,
			{ command: "model", args: "99", sessionId: session.id },
			{ defaultProviderId: providerId, defaultModel: "gpt-5-mini", configDir: tmpDir },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Invalid model index");
	});

	test("model command requires selecting a provider first when no provider/model defaults exist", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "model", args: "1", sessionId: session.id },
			{ defaultProviderId: null, defaultModel: null, configDir: tmpDir },
		);
		expect(result).toEqual({ ok: false, error: "Select a provider before selecting a model" });
	});

	test("model command creates session when none provided", () => {
		const result = handleCommand(
			db,
			{ command: "model", args: "1" },
			{ defaultProviderId: providerId, defaultModel: "gpt-5-mini", configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.sessionId).toBeDefined();
			expect(result.status).toBe("github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 0 / 0 | 0%");
			expect(result.provider).toBe("github-copilot");
			expect(result.model).toBe("claude-haiku-4.5");
			const session = getSession(db, result.sessionId ?? "");
			expect(session?.provider).toBe("github-copilot");
			expect(session?.model).toBe("claude-haiku-4.5");
		}
	});

	test("command-created sessions start from the configured default model, not the provider descriptor default", () => {
		const result = handleCommand(
			db,
			{ command: "title", args: "Configured" },
			{ defaultProviderId: "github-copilot", defaultModel: "gpt-5.4", configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const session = getSession(db, result.sessionId ?? "");
			expect(session?.provider).toBe("github-copilot");
			expect(session?.model).toBe("gpt-5.4");
		}
	});

	test("model command uses provider-aware options and the same config-backed sorted order as /bobai/models", () => {
		const configModels = [
			{ id: "claude-haiku-4.5", contextWindow: 1000 },
			{ id: "claude-sonnet-4.5", contextWindow: 500000 },
		];
		writeUnifiedModelsConfig(tmpDir, {
			"github-copilot": createCopilotModels(
				configModels.map((m) => ({
					id: m.id,
					name: m.id,
					contextWindow: m.contextWindow,
					maxOutput: 64000,
					premiumRequestMultiplier: 1,
				})),
			),
			openrouter: [
				{
					id: "anthropic/claude-haiku-4.5",
					name: "Anthropic Claude Haiku 4.5",
					contextWindow: 128000,
					maxOutput: 64000,
					inputPrice: 0.5,
					outputPrice: 5.12,
				},
				{
					id: "openrouter/free",
					name: "OpenRouter Free Router",
					contextWindow: 200000,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
			],
			"opencode-go": [
				{
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0.27,
					outputPrice: 1.1,
				},
			],
			"opencode-zen": [
				{
					id: "minimax-m2.5-free",
					name: "MiniMax M2.5 Free",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
				{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutput: 64000, inputPrice: 1, outputPrice: 4 },
			],
		});
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const result = handleCommand(
			db,
			{ command: "model", args: "1", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe("claude-haiku-4.5");
	});

	test("title command updates session title", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "title", args: "My Chat Title", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated?.title).toBe("My Chat Title");
	});

	test("title command rejects empty title", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "title", args: "", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Title cannot be empty");
	});

	test("unknown command returns error", () => {
		const session = createSession(db);
		const result = handleCommand(
			db,
			{ command: "foo", args: "", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Unknown command");
	});

	test("limit command sets context limit on session", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		const result = handleCommand(
			db,
			{ command: "limit", args: "20000", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated?.contextLimit).toBe(20000);
		if (result.ok) {
			expect(result.status).toContain("20000");
		}
	});

	test("limit command supports k suffix", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		const result = handleCommand(
			db,
			{ command: "limit", args: "10k", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		const updated = getSession(db, session.id);
		expect(updated?.contextLimit).toBe(10000);
	});

	test("limit command with no args clears the limit", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		// Set a limit first
		handleCommand(
			db,
			{ command: "limit", args: "5000", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(getSession(db, session.id)?.contextLimit).toBe(5000);

		// Clear it
		const result = handleCommand(
			db,
			{ command: "limit", args: "", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		expect(getSession(db, session.id)?.contextLimit).toBeNull();
	});

	test("limit command rejects invalid input", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		const result = handleCommand(
			db,
			{ command: "limit", args: "abc", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(false);
	});

	test("limit is cleared when provider/model changes", () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		handleCommand(
			db,
			{ command: "limit", args: "15000", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(getSession(db, session.id)?.contextLimit).toBe(15000);

		// Switch model — limit should be cleared
		handleCommand(
			db,
			{ command: "model", args: "1", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(getSession(db, session.id)?.contextLimit).toBeNull();
	});

	test("limit command status shows overridden format", () => {
		const freshDb = createTestDb();
		const session = createSession(freshDb, {
			provider: "github-copilot",
			model: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});
		// Give the session some prompt tokens
		updateSessionPromptTokens(freshDb, session.id, 1000, 4000);

		const result = handleCommand(
			freshDb,
			{ command: "limit", args: "20000", sessionId: session.id },
			{ defaultProviderId: providerId, configDir: tmpDir },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Should show "1000 / 20000 (<real_context_window>)" with 5% usage
			expect(result.status).toMatch(/1000 \/ 20000 \(\d+\)/);
			expect(result.status).toContain("5%");
		}
		freshDb.close();
	});
});

describe("HTTP endpoints", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let db: Database;
	let tmpDir: string;

	beforeAll(() => {
		db = createTestDb();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-test-"));
		writeUnifiedModelsConfig(tmpDir, {
			"github-copilot": createCopilotModels([
				{ id: "claude-haiku-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
				{ id: "claude-sonnet-4.5", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
				{ id: "gpt-5-mini", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 0 },
				{ id: "gpt-5.2", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
				{ id: "gpt-5.4", contextWindow: 0, maxOutput: 64000, premiumRequestMultiplier: 1 },
			]),
			openrouter: [
				{
					id: "anthropic/claude-haiku-4.5",
					name: "Anthropic Claude Haiku 4.5",
					contextWindow: 128000,
					maxOutput: 64000,
					inputPrice: 0.5,
					outputPrice: 5.12,
				},
				{
					id: "openrouter/free",
					name: "OpenRouter Free Router",
					contextWindow: 200000,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
			],
			"opencode-go": [
				{
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0.27,
					outputPrice: 1.1,
				},
			],
			"opencode-zen": [
				{
					id: "minimax-m2.5-free",
					name: "MiniMax M2.5 Free",
					contextWindow: 131072,
					maxOutput: 16384,
					inputPrice: 0,
					outputPrice: 0,
				},
				{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutput: 64000, inputPrice: 1, outputPrice: 4 },
			],
		});
		server = createServer({ port: 0, db, configDir: tmpDir, providerId: "github-copilot" });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("GET /bobai/models returns id-sorted model list with cost, context, defaultModel and defaultStatus for the configured provider", async () => {
		const res = await fetch(`${baseUrl}/bobai/models?provider=github-copilot`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.providerId).toBe("github-copilot");
		expect(body.models.length).toBe(5);
		expect(body.models[0]).toEqual({ index: 1, id: "claude-haiku-4.5", cost: "[0.33x]", contextWindow: 0 });
		expect(body.models.findIndex((model) => model.id === "claude-haiku-4.5")).toBeLessThan(
			body.models.findIndex((model) => model.id === "gpt-5.2"),
		);
		expect(body.models.findIndex((model) => model.id === "gpt-5.2")).toBeLessThan(
			body.models.findIndex((model) => model.id === "gpt-5.4"),
		);
		expect(body.defaultModel).toBe("gpt-5-mini");
		expect(body.defaultStatus).toBe("github-copilot | gpt-5-mini [0x] | 0 PR | 0 / 0 | 0%");
	});

	test("GET /bobai/models returns curated openrouter rows", async () => {
		const res = await fetch(`${baseUrl}/bobai/models?provider=openrouter`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.providerId).toBe("openrouter");
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "anthropic/claude-haiku-4.5",
			cost: "[$0.50 $5.12]",
			contextWindow: 128000,
		});
		expect(body.defaultModel).toBe("openrouter/free");
		expect(body.defaultStatus).toBe("openrouter | openrouter/free [$0.00 $0.00] | $0.00 | 0 / 200000 | 0%");
	});

	test("GET /bobai/models returns curated opencode-go rows", async () => {
		const res = await fetch(`${baseUrl}/bobai/models?provider=opencode-go`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.providerId).toBe("opencode-go");
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "deepseek-v4-flash",
			cost: "[$0.27 $1.10]",
			contextWindow: 131072,
		});
		expect(body.defaultModel).toBe("deepseek-v4-flash");
		expect(body.defaultStatus).toBe("opencode-go | deepseek-v4-flash [$0.27 $1.10] | $0.00 | 0 / 131072 | 0%");
	});

	test("GET /bobai/models returns curated opencode-zen rows", async () => {
		const res = await fetch(`${baseUrl}/bobai/models?provider=opencode-zen`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string;
			defaultStatus: string;
		};
		expect(body.providerId).toBe("opencode-zen");
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "minimax-m2.5-free",
			cost: "[$0.00 $0.00]",
			contextWindow: 131072,
		});
		expect(body.models).toContainEqual({
			index: expect.any(Number),
			id: "gpt-5.4",
			cost: "[$1.00 $4.00]",
			contextWindow: 272000,
		});
		expect(body.defaultModel).toBe("minimax-m2.5-free");
		expect(body.defaultStatus).toBe("opencode-zen | minimax-m2.5-free [$0.00 $0.00] | $0.00 | 0 / 131072 | 0%");
	});

	test("GET /bobai/models without a configured default backend returns select-provider status", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb, defaultStatus: "select provider and model" });
		const base = `http://localhost:${s.port}`;
		const res = await fetch(`${base}/bobai/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerId: string | null;
			models: { index: number; id: string; cost: string; contextWindow: number }[];
			defaultModel: string | null;
			defaultStatus: string;
		};
		expect(body.providerId).toBeNull();
		expect(body.models).toEqual([]);
		expect(body.defaultModel).toBeNull();
		expect(body.defaultStatus).toBe("select provider and model");
		s.stop(true);
		freshDb.close();
	});

	test("POST /bobai/command executes model command using the same canonical order as /bobai/models", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const modelsRes = await fetch(`${baseUrl}/bobai/models?provider=github-copilot`);
		const modelsBody = (await modelsRes.json()) as { models: { index: number; id: string }[] };
		const firstVisible = modelsBody.models[0];
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "1", sessionId: session.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; status?: string };
		expect(body.ok).toBe(true);
		expect(firstVisible?.id).toBe("claude-haiku-4.5");
		expect(body.status).toBe("github-copilot | claude-haiku-4.5 [0.33x] | 0 PR | 0 / 0 | 0%");
		const updated = getSession(db, session.id);
		expect(updated?.model).toBe(firstVisible?.id);
	});

	test("POST /bobai/command returns error for bad command", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "foo", args: "", sessionId: session.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("Unknown command");
	});

	test("GET /bobai/subagents returns recent subagent sessions", async () => {
		const parent = createSession(db);
		createSubagentSession(db, parent.id, "HTTP Task A", "gpt-5-mini");

		const res = await fetch(`${baseUrl}/bobai/subagents?parentId=${parent.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { index: number; title: string; sessionId: string }[];
		expect(body.length).toBeGreaterThanOrEqual(1);
		const match = body.find((s) => s.title === "HTTP Task A");
		expect(match).toBeTruthy();
		expect(match?.sessionId).toBeTruthy();
	});

	test("GET /bobai/sessions returns parent sessions sorted by updated_at", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const s1 = createSession(freshDb);
		updateSessionTitle(freshDb, s1.id, "First");
		const s2 = createSession(freshDb);
		updateSessionTitle(freshDb, s2.id, "Second");
		// s2 is more recent
		const res = await fetch(`${base}/bobai/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { index: number; id: string; title: string | null; updatedAt: string }[];
		expect(body.length).toBeGreaterThanOrEqual(2);
		expect(body[0].title).toBe("Second");
		expect(body[0].index).toBe(1);
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/sessions/recent returns most recent parent session", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		createSession(freshDb, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		const s2 = createSession(freshDb, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		updateSessionTitle(freshDb, s2.id, "Latest");
		const res = await fetch(`${base}/bobai/sessions/recent`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			title: string | null;
			provider: string | null;
			model: string | null;
		} | null;
		expect(body).not.toBeNull();
		expect(body?.id).toBe(s2.id);
		expect(body?.provider).toBe("github-copilot");
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/sessions/recent returns null when no sessions", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const res = await fetch(`${base}/bobai/sessions/recent`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toBeNull();
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/session/:id/load returns session metadata and messages", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const session = createSession(freshDb, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		updateSessionTitle(freshDb, session.id, "Test Session");
		appendMessage(freshDb, session.id, "user", "hello");
		appendMessage(freshDb, session.id, "assistant", "hi there");
		const res = await fetch(`${base}/bobai/session/${session.id}/load`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			session: { id: string; title: string; provider: string | null; model: string | null; parentId: string | null };
			messages: { role: string; content: string }[];
		};
		expect(body.session.id).toBe(session.id);
		expect(body.session.title).toBe("Test Session");
		expect(body.session.provider).toBe("github-copilot");
		expect(body.messages.length).toBe(2); // user + assistant
		s.stop(true);
		freshDb.close();
	});

	test("GET /bobai/session/:id/load returns 404 for unknown session", async () => {
		const res = await fetch(`${baseUrl}/bobai/session/nonexistent/load`);
		expect(res.status).toBe(404);
	});

	test("DELETE /bobai/session/:id deletes session and returns ok", async () => {
		const freshDb = createTestDb();
		const s = createServer({ port: 0, db: freshDb });
		const base = `http://localhost:${s.port}`;
		const session = createSession(freshDb);
		updateSessionTitle(freshDb, session.id, "Doomed Session");
		appendMessage(freshDb, session.id, "user", "hello");

		const res = await fetch(`${base}/bobai/session/${session.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; id: string; title: string | null };
		expect(body.ok).toBe(true);
		expect(body.id).toBe(session.id);
		expect(body.title).toBe("Doomed Session");
		expect(getSession(freshDb, session.id)).toBeNull();
		s.stop(true);
		freshDb.close();
	});

	test("DELETE /bobai/session/:id returns error for unknown session", async () => {
		const res = await fetch(`${baseUrl}/bobai/session/nonexistent`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("Session not found");
	});
});

describe("handlePrompt respects session model", () => {
	let db: Database;
	const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("uses session model when set", async () => {
		const session = createSession(db);
		updateSessionModel(db, session.id, "claude-sonnet-4.6");

		const captured: ProviderOptions[] = [];
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({
			ws,
			db,
			provider,
			defaultProviderId: "github-copilot",
			model: "gpt-5-mini",
			text: "hello",
			sessionId: session.id,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		expect(captured[0].model).toBe("claude-sonnet-4.6");
	});

	test("falls back to default model when session model is null", async () => {
		const session = createSession(db);

		const captured: ProviderOptions[] = [];
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({
			ws,
			db,
			provider,
			defaultProviderId: "github-copilot",
			model: "gpt-5-mini",
			text: "hello",
			sessionId: session.id,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		expect(captured[0].model).toBe("gpt-5-mini");
	});

	test("done message includes session model when set", async () => {
		const session = createSession(db);
		updateSessionModel(db, session.id, "claude-opus-4.6");

		const provider: Provider = {
			id: "mock",
			async *stream(): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({
			ws,
			db,
			provider,
			defaultProviderId: "github-copilot",
			model: "gpt-5-mini",
			text: "hello",
			sessionId: session.id,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = sent.map((s) => JSON.parse(s));
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.model).toBe("claude-opus-4.6");
	});

	test("done message includes session title", async () => {
		const session = createSession(db);
		updateSessionTitle(db, session.id, "Test Title");

		const provider: Provider = {
			id: "mock",
			async *stream(): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const sent: string[] = [];
		const ws = {
			send(msg: string) {
				sent.push(msg);
			},
		};

		await handlePrompt({
			ws,
			db,
			provider,
			defaultProviderId: "github-copilot",
			model: "gpt-5-mini",
			text: "hello",
			sessionId: session.id,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = sent.map((s) => JSON.parse(s));
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.title).toBe("Test Title");
	});
});
