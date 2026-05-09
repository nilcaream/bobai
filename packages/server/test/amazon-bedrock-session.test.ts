import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { saveAuthStore } from "../src/auth/store";
import { createServer } from "../src/server";
import { createSession, getMessages, getSession } from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb, openWs } from "./helpers";
import { createProviderModelsTempDir } from "./test-provider-models";

const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

describe("Amazon Bedrock session flow", () => {
	let tmpDir: string;
	let db: ReturnType<typeof createTestDb>;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let wsUrl: string;
	let seenProviderIds: string[];

	beforeAll(() => {
		tmpDir = createProviderModelsTempDir();
		saveAuthStore(tmpDir, {
			version: 1,
			providers: {
				"github-copilot": { refresh: "r", access: "a", expires: Date.now() + 60_000 },
				openrouter: { apiKey: "or-key" },
				"opencode-go": { apiKey: "go-key" },
				"opencode-zen": { apiKey: "zen-key" },
				"amazon-bedrock": { apiKey: "bedrock-key", region: "us-east-1" },
			},
		});
		db = createTestDb();
		seenProviderIds = [];
		const runtimeManager = {
			get: async (providerId: "github-copilot" | "openrouter" | "opencode-go" | "opencode-zen" | "amazon-bedrock") => {
				seenProviderIds.push(providerId);
				return {
					id: providerId,
					configDir: tmpDir,
					async *stream(opts: {
						model: string;
						onMetrics?: (metrics: {
							model: string;
							promptTokens: number;
							outputTokens: number;
							promptChars: number;
							totalTokens: number;
						}) => void;
					}) {
						yield { type: "text" as const, text: `amazon bedrock response for ${opts.model}` };
						opts.onMetrics?.({
							model: opts.model,
							promptTokens: 5000,
							outputTokens: 2000,
							promptChars: 100,
							totalTokens: 7000,
						});
						yield { type: "finish" as const, reason: "stop" as const };
					},
				};
			},
		};
		server = createServer({
			port: 0,
			db,
			configDir: tmpDir,
			runtimeManager,
			providerId: "github-copilot",
			model: "gpt-5-mini",
			projectRoot: "/tmp",
			skills: emptySkills,
		});
		baseUrl = `http://localhost:${server.port}`;
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
	});

	afterAll(() => {
		server.stop(true);
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		seenProviderIds = [];
	});

	test("provider command switches an empty session to Amazon Bedrock and defaults to the Anthropic model", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		// amazon-bedrock is index 5 (copilot=1, openrouter=2, opencode-go=3, opencode-zen=4, amazon-bedrock=5)
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "5", sessionId: session.id }),
		});
		const body = (await res.json()) as { ok: boolean; provider?: string; model?: string; status?: string };

		expect(body.ok).toBe(true);
		expect(body.provider).toBe("amazon-bedrock");
		expect(body.model).toBe("anthropic.claude-opus-4-7");
		expect(body.status).toBe("amazon-bedrock | anthropic.claude-opus-4-7 [$15.00 $75.00] | $0.00 | 0 / 1000000 | 0%");
	});

	test("selecting amazon-bedrock with default Anthropic model resolves to anthropic-messages backend", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "5", sessionId: session.id }),
		});

		const ws = await openWs(wsUrl);
		const messages: Array<Record<string, unknown>> = [];
		await new Promise<void>((resolve, reject) => {
			ws.onmessage = (event) => {
				const parsed = JSON.parse(event.data as string) as Record<string, unknown>;
				messages.push(parsed);
				if (parsed.type === "done") {
					ws.close();
				}
			};
			ws.onclose = () => resolve();
			ws.onerror = (event) => reject(event);
			ws.send(JSON.stringify({ type: "prompt", text: "hello", sessionId: session.id }));
		});

		expect(seenProviderIds).toContain("amazon-bedrock");
		expect(messages.some((m) => m.type === "token" && m.text === "amazon bedrock response for anthropic.claude-opus-4-7")).toBe(
			true,
		);
		const done = messages.find((m) => m.type === "done");
		expect(done?.provider).toBe("amazon-bedrock");
		expect(done?.model).toBe("anthropic.claude-opus-4-7");
		const stored = getMessages(db, session.id);
		expect(stored.at(-1)?.metadata?.turn_model).toBe("anthropic.claude-opus-4-7");
		expect(getSession(db, session.id)?.apiFamily).toBe("anthropic-messages");
	});

	test("selecting a non-Anthropic model on amazon-bedrock resolves to openai-chat-completions backend", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		// Switch provider to amazon-bedrock
		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "5", sessionId: session.id }),
		});
		// Sorted amazon-bedrock models: anthropic.claude-haiku-4-5(1), anthropic.claude-opus-4-7(2), deepseek.v3-v1:0(3), mistral.devstral-2-123b(4)
		const deepseekRes = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "3", sessionId: session.id }),
		});
		const deepseekBody = (await deepseekRes.json()) as { ok: boolean; model?: string };

		expect(deepseekBody.ok).toBe(true);
		expect(deepseekBody.model).toBe("deepseek.v3-v1:0");

		const ws = await openWs(wsUrl);
		const messages: Array<Record<string, unknown>> = [];
		await new Promise<void>((resolve, reject) => {
			ws.onmessage = (event) => {
				const parsed = JSON.parse(event.data as string) as Record<string, unknown>;
				messages.push(parsed);
				if (parsed.type === "done") {
					ws.close();
				}
			};
			ws.onclose = () => resolve();
			ws.onerror = (event) => reject(event);
			ws.send(JSON.stringify({ type: "prompt", text: "hello", sessionId: session.id }));
		});

		const done = messages.find((m) => m.type === "done");
		expect(done?.provider).toBe("amazon-bedrock");
		expect(done?.model).toBe("deepseek.v3-v1:0");
		const stored = getMessages(db, session.id);
		expect(stored.at(-1)?.metadata?.turn_model).toBe("deepseek.v3-v1:0");
		expect(getSession(db, session.id)?.apiFamily).toBe("openai-chat-completions");
	});

	test("model switch within amazon-bedrock from Anthropic to non-Anthropic model is rejected for non-empty session", async () => {
		const session = createSession(db, {
			provider: "amazon-bedrock",
			model: "anthropic.claude-opus-4-7",
			apiFamily: "anthropic-messages",
		});
		// Add a message so the session is non-empty
		const { appendMessage } = await import("../src/session/repository");
		appendMessage(db, session.id, "user", "hello");

		// Try to switch to a non-Anthropic model (cross-family switch should be rejected)
		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "3", sessionId: session.id }),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };

		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/API|not yet supported/i);
	});
});
