import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { saveAuthStore } from "../src/auth/store";
import { createServer } from "../src/server";
import { createSession, getMessages } from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb, openWs } from "./helpers";
import { createProviderModelsTempDir } from "./test-provider-models";

const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

describe("DeepSeek session flow", () => {
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
				deepseek: { apiKey: "ds-key" },
			},
		});
		db = createTestDb();
		seenProviderIds = [];
		const runtimeManager = {
			get: async (providerId: "github-copilot" | "deepseek") => {
				seenProviderIds.push(providerId);
				return {
					id: providerId,
					configDir: tmpDir,
					async *stream(opts: {
						onMetrics?: (metrics: {
							model: string;
							promptTokens: number;
							outputTokens: number;
							promptChars: number;
							totalTokens: number;
						}) => void;
					}) {
						yield { type: "text" as const, text: "deepseek response" };
						opts.onMetrics?.({
							model: "deepseek-v4-flash",
							promptTokens: 5000,
							outputTokens: 1500,
							promptChars: 80,
							totalTokens: 6500,
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

	test("provider command switches an empty session to DeepSeek and resets the model", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		const res = await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: String(2), sessionId: session.id }),
		});
		const body = (await res.json()) as { ok: boolean; provider?: string; model?: string; status?: string };

		expect(body.ok).toBe(true);
		expect(body.provider).toBe("deepseek");
		expect(body.model).toBe("deepseek-v4-flash");
		expect(body.status).toBe("deepseek | deepseek-v4-flash [$0.14 $0.28] | $0.00 | 0 / 1000000 | 0%");
	});

	test("websocket prompt uses the DeepSeek runtime after provider switch", async () => {
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		await fetch(`${baseUrl}/bobai/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "provider", args: String(2), sessionId: session.id }),
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

		expect(seenProviderIds).toContain("deepseek");
		expect(messages.some((m) => m.type === "token" && m.text === "deepseek response")).toBe(true);
		const done = messages.find((m) => m.type === "done");
		expect(done?.provider).toBe("deepseek");
		expect(done?.model).toBe("deepseek-v4-flash");
		expect(done?.summary).toMatch(
			/^ \| deepseek-v4-flash \| in: 5000 \| out: 1500 \| estimate: \$0\.00 \| context: \+5000 \| \d+\.\d{2}s$/,
		);
		const stored = getMessages(db, session.id);
		expect(stored.at(-1)?.metadata?.turn_model).toBe("deepseek-v4-flash");
		expect(stored.at(-1)?.metadata?.summary).toMatch(
			/^ \| deepseek-v4-flash \| in: 5000 \| out: 1500 \| estimate: \$0\.00 \| context: \+5000 \| \d+\.\d{2}s$/,
		);
	});
});
