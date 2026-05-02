import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAuthStore } from "../src/auth/store";
import { createServer } from "../src/server";
import { createSession, getMessages } from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb, openWs } from "./helpers";

const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

describe("OpenCode Zen session flow", () => {
	let tmpDir: string;
	let db: ReturnType<typeof createTestDb>;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;
	let wsUrl: string;
	let seenProviderIds: string[];

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-opencode-zen-session-"));
		saveAuthStore(tmpDir, {
			version: 1,
			providers: {
				"github-copilot": { refresh: "r", access: "a", expires: Date.now() + 60_000 },
				openrouter: { apiKey: "or-key" },
				"opencode-go": { apiKey: "go-key" },
				"opencode-zen": { apiKey: "zen-key" },
			},
		});
		db = createTestDb();
		seenProviderIds = [];
		const runtimeManager = {
			get: async (providerId: "github-copilot" | "openrouter" | "opencode-go" | "opencode-zen") => {
				seenProviderIds.push(providerId);
				return {
					id: providerId,
					async *stream(opts: {
						model: string;
						initiator?: "user" | "agent";
						onMetrics?: (metrics: {
							model: string;
							promptTokens: number;
							outputTokens: number;
							promptChars: number;
							totalTokens: number;
							initiator: "user" | "agent";
						}) => void;
					}) {
						yield { type: "text" as const, text: `opencode zen response for ${opts.model}` };
						opts.onMetrics?.({
							model: opts.model,
							promptTokens: 7473,
							outputTokens: 3123,
							promptChars: 100,
							totalTokens: 10596,
							initiator: opts.initiator ?? "user",
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

	test("provider command switches an empty session to OpenCode Zen and resets the model", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "4", sessionId: session.id }),
		});
		const body = (await res.json()) as { ok: boolean; provider?: string; model?: string; status?: string };

		expect(body.ok).toBe(true);
		expect(body.provider).toBe("opencode-zen");
		expect(body.model).toBe("minimax-m2.5-free");
		expect(body.status).toBe("opencode-zen | minimax-m2.5-free | free | 0 / 131072 | 0%");
	});

	test("websocket prompt uses the OpenCode Zen runtime after provider switch", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "4", sessionId: session.id }),
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

		expect(seenProviderIds).toContain("opencode-zen");
		expect(messages.some((m) => m.type === "token" && m.text === "opencode zen response for minimax-m2.5-free")).toBe(true);
		const done = messages.find((m) => m.type === "done");
		expect(done?.provider).toBe("opencode-zen");
		expect(done?.model).toBe("minimax-m2.5-free");
		expect(done?.summary).toMatch(/^ \| minimax-m2\.5-free \| in: 7473 \| out: 3123 \| context: \+7473 \| \d+\.\d{2}s$/);
		const stored = getMessages(db, session.id);
		expect(stored.at(-1)?.metadata?.turn_model).toBe("minimax-m2.5-free");
		expect(stored.at(-1)?.metadata?.summary).toMatch(
			/^ \| minimax-m2\.5-free \| in: 7473 \| out: 3123 \| context: \+7473 \| \d+\.\d{2}s$/,
		);
	});

	test("websocket prompt uses the OpenCode Zen runtime after switching to a GPT responses model", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: "4", sessionId: session.id }),
		});
		const modelsRes = await fetch(`${baseUrl}/bobai/models?provider=opencode-zen`);
		const modelsBody = (await modelsRes.json()) as { models: { index: number; id: string }[] };
		const gptIndex = modelsBody.models.find((model) => model.id === "gpt-5.4")?.index;
		expect(gptIndex).toBeDefined();
		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: String(gptIndex), sessionId: session.id }),
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

		expect(messages.some((m) => m.type === "token" && m.text === "opencode zen response for gpt-5.4")).toBe(true);
		const done = messages.find((m) => m.type === "done");
		expect(done?.provider).toBe("opencode-zen");
		expect(done?.model).toBe("gpt-5.4");
		expect(done?.summary).toMatch(/^ \| gpt-5.4 \| in: 7473 \| out: 3123 \| context: \+7473 \| \d+\.\d{2}s$/);
		const stored = getMessages(db, session.id);
		expect(stored.at(-1)?.metadata?.turn_model).toBe("gpt-5.4");
		expect(stored.at(-1)?.metadata?.summary).toMatch(
			/^ \| gpt-5.4 \| in: 7473 \| out: 3123 \| context: \+7473 \| \d+\.\d{2}s$/,
		);
	});
});
