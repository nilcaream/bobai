import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { AuthError, ProviderError } from "../src/provider/provider";
import type { ProviderRuntimeManager } from "../src/provider/runtime-manager";
import { createSession, getMessages, updateSessionPromptTokens } from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb } from "./helpers";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

function mockWs() {
	const sent: string[] = [];
	return {
		send(msg: string) {
			sent.push(msg);
		},
		messages() {
			return sent.map((s) => JSON.parse(s));
		},
	};
}

function mockProvider(tokens: string[]): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

/** Provider that captures the messages it received */
function capturingProvider(tokens: string[]): Provider & { captured: ProviderOptions[] } {
	const captured: ProviderOptions[] = [];
	return {
		id: "mock",
		captured,
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			captured.push(opts);
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

function failingProvider(status: number, body: string): Provider {
	return {
		id: "mock",
		stream() {
			async function* gen(): AsyncGenerator<StreamEvent> {
				yield* [];
				throw new ProviderError(status, body);
			}
			return gen();
		},
	};
}

function metricsProvider(
	providerId: Provider["id"],
	model: string,
	promptTokens: number,
	outputTokens: number,
	text = "summary text",
): Provider {
	return {
		id: providerId,
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text };
			opts.onMetrics?.({
				model,
				promptTokens,
				outputTokens,
				promptChars: 100,
				totalTokens: promptTokens + outputTokens,
				initiator: opts.initiator ?? "user",
			});
			yield { type: "finish", reason: "stop" };
		},
	};
}

function multiMetricsProvider(
	providerId: Provider["id"],
	model: string,
	calls: Array<{ promptTokens: number; outputTokens: number; promptChars?: number }>,
	text = "summary text",
): Provider {
	return {
		id: providerId,
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text };
			for (const call of calls) {
				opts.onMetrics?.({
					model,
					promptTokens: call.promptTokens,
					outputTokens: call.outputTokens,
					promptChars: call.promptChars ?? 100,
					totalTokens: call.promptTokens + call.outputTokens,
					initiator: opts.initiator ?? "user",
				});
			}
			yield { type: "finish", reason: "stop" };
		},
	};
}

function authFailingProvider(status: number, body: string, permanent: boolean, providerId: Provider["id"] = "mock"): Provider {
	return {
		id: providerId,
		stream() {
			async function* gen(): AsyncGenerator<StreamEvent> {
				yield* [];
				throw new AuthError(status, body, permanent);
			}
			return gen();
		},
	};
}

/** Provider that yields some tokens then throws a ProviderError */
function partialFailingProvider(tokens: string[], status: number, body: string): Provider {
	return {
		id: "mock",
		stream() {
			async function* gen(): AsyncGenerator<StreamEvent> {
				for (const t of tokens) yield { type: "text", text: t };
				throw new ProviderError(status, body);
			}
			return gen();
		},
	};
}

describe("handlePrompt", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("creates new session when no sessionId provided", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello"]);
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};
		await handlePrompt({
			ws,
			db,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.sessionId).toBeTruthy();
	});

	test("uses runtime manager to resolve the active provider for the session", async () => {
		const ws = mockWs();
		const fallbackProvider: Provider = {
			id: "mock",
			stream() {
				throw new Error("fallback provider should not be used");
			},
		};
		const managedProvider = mockProvider(["managed provider"]);
		let requestedProviderId: string | undefined;
		const runtimeManager: ProviderRuntimeManager = {
			get: async (providerId) => {
				requestedProviderId = providerId;
				return managedProvider;
			},
		};
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});

		await handlePrompt({
			ws,
			db,
			provider: fallbackProvider,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "hi",
			sessionId: session.id,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		expect(requestedProviderId).toBe("github-copilot");
		const msgs = ws.messages();
		expect(msgs.find((m: { type: string; text?: string }) => m.type === "token" && m.text === "managed provider")).toBeTruthy();
	});

	test("streams tokens then done with sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};
		await handlePrompt({
			ws,
			db,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " world" },
		]);
		expect(msgs.at(-1).type).toBe("done");
		expect(msgs.at(-1).sessionId).toBeTruthy();
	});

	test("completes prompt handling when provider-specific model metadata exists", async () => {
		const ws = mockWs();
		const provider = mockProvider(["metadata ok"]);
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{
						id: "gpt-5-mini",
						name: "GPT-5 Mini",
						contextWindow: 264000,
						maxOutput: 64000,
						premiumRequestMultiplier: 0,
					},
				]),
			});

			await handlePrompt({
				ws,
				db,
				runtimeManager,
				defaultProviderId: "github-copilot",
				model: "gpt-5-mini",
				text: "hi",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const msgs = ws.messages();
			expect(msgs.find((m: { type: string }) => m.type === "done")).toBeTruthy();
			expect(msgs.find((m: { type: string; text?: string }) => m.type === "token" && m.text === "metadata ok")).toBeTruthy();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("persists user and assistant messages to DB", async () => {
		const ws = mockWs();
		const provider = mockProvider(["response text"]);
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};
		await handlePrompt({
			ws,
			db,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "my question",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		expect(stored).toHaveLength(2); // user + assistant (system prompt is dynamic, not stored)
		expect(stored[0].role).toBe("user");
		expect(stored[0].content).toBe("my question");
		expect(stored[1].role).toBe("assistant");
		expect(stored[1].content).toBe("response text");
	});

	test("persists assistant reasoning metadata through the real handlePrompt path", async () => {
		const ws = mockWs();
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield {
					type: "reasoning_start",
					index: 0,
					reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "thinking" },
				};
				yield { type: "reasoning_delta", index: 0, delta: { kind: "text", text: " harder" } };
				yield { type: "reasoning_end", index: 0, reasoning: { kind: "text-summary", text: "done" } };
				yield { type: "text", text: "reasoned answer" };
				yield { type: "finish", reason: "stop" };
			},
		};
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};

		await handlePrompt({
			ws,
			db,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "my question",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);
		const assistant = stored.at(-1);

		expect(assistant?.role).toBe("assistant");
		expect(assistant?.content).toBe("reasoned answer");
		expect(assistant?.metadata?.reasoning).toEqual([
			{ kind: "interleaved-chat", field: "reasoning_content", text: "thinking harder" },
			{ kind: "text-summary", text: "done" },
		]);
	});

	test("formats github-copilot message summaries with the model label", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-summary-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": [
					{
						id: "claude-haiku-4.5",
						name: "Claude Haiku 4.5",
						contextWindow: 128000,
						maxOutput: 64000,
						inputPrice: 0,
						outputPrice: 0,
						premiumRequestMultiplier: 0.33,
					},
				],
			});
			const session = createSession(db, {
				provider: "github-copilot",
				model: "claude-haiku-4.5",
				apiFamily: "anthropic-messages",
			});
			updateSessionPromptTokens(db, session.id, 3760, 0);
			await handlePrompt({
				ws,
				db,
				provider: metricsProvider("github-copilot", "claude-haiku-4.5", 7473, 3123),
				defaultProviderId: "github-copilot",
				sessionId: session.id,
				model: "claude-haiku-4.5",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 7473 \| out: 3123 \| context: \+3713 \| \d+\.\d{2}s$/,
			);
			const stored = getMessages(db, session.id);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 7473 \| out: 3123 \| context: \+3713 \| \d+\.\d{2}s$/,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("formats openrouter message summaries with estimated cost", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-openrouter-summary-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				openrouter: [
					{
						id: "anthropic/claude-haiku-4.5",
						name: "Anthropic Claude Haiku 4.5",
						contextWindow: 128000,
						maxOutput: 64000,
						inputPrice: 0.5,
						outputPrice: 5.12,
					},
				],
			});
			const session = createSession(db, {
				provider: "openrouter",
				model: "anthropic/claude-haiku-4.5",
				apiFamily: "openai-chat-completions",
			});
			updateSessionPromptTokens(db, session.id, 3760, 0);
			await handlePrompt({
				ws,
				db,
				provider: metricsProvider("openrouter", "anthropic/claude-haiku-4.5", 7473, 3123),
				defaultProviderId: "openrouter",
				sessionId: session.id,
				model: "anthropic/claude-haiku-4.5",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| in: 7473 \| out: 3123 \| estimate: \$0\.02 \| context: \+3713 \| \d+\.\d{2}s$/,
			);
			const stored = getMessages(db, session.id);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| in: 7473 \| out: 3123 \| estimate: \$0\.02 \| context: \+3713 \| \d+\.\d{2}s$/,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("formats free openrouter message summaries with a free label", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-openrouter-free-"));
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
			const session = createSession(db, {
				provider: "openrouter",
				model: "openrouter/free",
				apiFamily: "openai-chat-completions",
			});
			updateSessionPromptTokens(db, session.id, 5007, 0);
			await handlePrompt({
				ws,
				db,
				provider: metricsProvider("openrouter", "tencent/hy3-preview:free", 7446, 279),
				defaultProviderId: "openrouter",
				sessionId: session.id,
				model: "openrouter/free",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(/^ \| hy3-preview:free \| in: 7446 \| out: 279 \| context: \+2439 \| \d+\.\d{2}s$/);
			const stored = getMessages(db, session.id);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| hy3-preview:free \| in: 7446 \| out: 279 \| context: \+2439 \| \d+\.\d{2}s$/,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("persists non-zero output tokens for Copilot responses models", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-copilot-responses-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": [
					{
						id: "gpt-5.4",
						name: "GPT-5.4",
						contextWindow: 400000,
						maxOutput: 128000,
						inputPrice: 0,
						outputPrice: 0,
						premiumRequestMultiplier: 1,
					},
				],
			});
			await handlePrompt({
				ws,
				db,
				provider: metricsProvider("github-copilot", "gpt-5.4", 27478, 3123),
				defaultProviderId: "github-copilot",
				model: "gpt-5.4",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(/^ \| gpt-5\.4 \| 1x \| in: 27478 \| out: 3123 \| context: \+27478 \| \d+\.\d{2}s$/);
			const stored = getMessages(db, done?.sessionId as string);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| gpt-5\.4 \| 1x \| in: 27478 \| out: 3123 \| context: \+27478 \| \d+\.\d{2}s$/,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("persists non-zero output tokens for Copilot anthropic models", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-copilot-anthropic-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": [
					{
						id: "claude-haiku-4.5",
						name: "Claude Haiku 4.5",
						contextWindow: 128000,
						maxOutput: 64000,
						inputPrice: 0,
						outputPrice: 0,
						premiumRequestMultiplier: 0.33,
					},
				],
			});
			await handlePrompt({
				ws,
				db,
				provider: metricsProvider("github-copilot", "claude-haiku-4.5", 5948, 731),
				defaultProviderId: "github-copilot",
				model: "claude-haiku-4.5",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 5948 \| out: 731 \| context: \+5948 \| \d+\.\d{2}s$/,
			);
			const stored = getMessages(db, done?.sessionId as string);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 5948 \| out: 731 \| context: \+5948 \| \d+\.\d{2}s$/,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("persists total turn metrics in summary and structured metadata without schema changes", async () => {
		const ws = mockWs();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-handler-turn-metrics-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": [
					{
						id: "claude-haiku-4.5",
						name: "Claude Haiku 4.5",
						contextWindow: 128000,
						maxOutput: 64000,
						inputPrice: 0,
						outputPrice: 0,
						premiumRequestMultiplier: 0.33,
					},
				],
			});
			await handlePrompt({
				ws,
				db,
				provider: multiMetricsProvider("github-copilot", "claude-haiku-4.5", [
					{ promptTokens: 5000, outputTokens: 400, promptChars: 700 },
					{ promptTokens: 5948, outputTokens: 731, promptChars: 900 },
				]),
				defaultProviderId: "github-copilot",
				model: "claude-haiku-4.5",
				text: "hello",
				projectRoot: "/tmp",
				configDir: tmpDir,
				skills: emptySkills,
			});

			const done = ws.messages().find((m: { type: string; summary?: string }) => m.type === "done");
			expect(done?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 10948 \| out: 1131 \| context: \+5948 \| \d+\.\d{2}s$/,
			);
			const stored = getMessages(db, done?.sessionId as string);
			expect(stored.at(-1)?.metadata?.summary).toMatch(
				/^ \| claude-haiku-4\.5 \| 0\.33x \| in: 10948 \| out: 1131 \| context: \+5948 \| \d+\.\d{2}s$/,
			);
			expect(stored.at(-1)?.metadata?.turn_metrics).toEqual({
				input_tokens_total: 10948,
				output_tokens_total: 1131,
				input_tokens_last: 5948,
				output_tokens_last: 731,
				context_delta: 5948,
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("resumes existing session with sessionId", async () => {
		const ws1 = mockWs();
		const provider1 = mockProvider(["first response"]);
		const runtimeManager1: ProviderRuntimeManager = {
			get: async () => provider1,
		};
		await handlePrompt({
			ws: ws1,
			db,
			runtimeManager: runtimeManager1,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "first",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});
		const sessionId = ws1.messages().find((m: { type: string }) => m.type === "done").sessionId;

		const ws2 = mockWs();
		const provider2 = capturingProvider(["second response"]);
		const runtimeManager2: ProviderRuntimeManager = {
			get: async () => provider2,
		};
		await handlePrompt({
			ws: ws2,
			db,
			runtimeManager: runtimeManager2,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "second",
			sessionId,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		// Provider should have received full history (system + user1 + assistant1 + user2)
		// Note: the agent loop appends its response to the conversation array after streaming,
		// so the captured reference also contains the new assistant message (5 total)
		const sentMessages = provider2.captured[0].messages;
		expect(sentMessages).toHaveLength(5); // system + user1 + assistant1 + user2 + assistant2 (appended by agent loop)
		expect(sentMessages[0].role).toBe("system");
		expect(sentMessages[1].content).toBe("first");
		expect(sentMessages[2].content).toBe("first response");
		expect(sentMessages[3].content).toBe("second");
		expect(sentMessages[4].content).toBe("second response");

		// DB should have 4 messages total
		const stored = getMessages(db, sessionId);
		expect(stored).toHaveLength(4); // user1 + assistant1 + user2 + assistant2 (system prompt is dynamic, not stored)
	});

	test("sends error for unknown sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["x"]);
		const runtimeManager: ProviderRuntimeManager = {
			get: async () => provider,
		};
		await handlePrompt({
			ws,
			db,
			runtimeManager,
			defaultProviderId: "github-copilot",
			model: "test-model",
			text: "hi",
			sessionId: "nonexistent",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("not found");
	});

	test("sends error on ProviderError", async () => {
		const ws = mockWs();
		const provider = failingProvider(401, "Unauthorized");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("401");
	});

	test("sends tokens and error when provider errors mid-stream", async () => {
		const ws = mockWs();
		const provider = partialFailingProvider(["Hello", " wor"], 500, "Internal Server Error");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "tell me something",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();

		// Tokens yielded before the error should be sent to the client
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " wor" },
		]);

		// Error should be sent to the client
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("500");
	});

	test("stores whitespace-only assistant content as empty for tool-call turns", async () => {
		let callCount = 0;
		const toolProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "text", text: "\n \t" };
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "I see the files" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider: toolProvider,
			model: "test-model",
			text: "what files?",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const sessionId = ws.messages().find((m: { type: string }) => m.type === "done").sessionId;
		const stored = getMessages(db, sessionId);
		expect(stored[1]?.role).toBe("assistant");
		expect(stored[1]?.content).toBe("");
		expect(stored[1]?.metadata?.tool_calls).toBeTruthy();
	});

	test("executes tool calls and persists tool messages", async () => {
		// Provider that requests a tool call then responds with text
		let callCount = 0;
		const toolProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "I see the files" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider: toolProvider,
			model: "test-model",
			text: "what files?",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		// Should have tool_call, tool_result, text token(s), and done
		expect(msgs.some((m: { type: string }) => m.type === "tool_call")).toBe(true);
		expect(msgs.some((m: { type: string }) => m.type === "tool_result")).toBe(true);
		expect(msgs.at(-1).type).toBe("done");

		const toolCall = msgs.find((m: { type: string }) => m.type === "tool_call");
		expect(toolCall.output).toBeTruthy(); // pre-formatted markdown
		expect(toolCall.name).toBeUndefined(); // name no longer sent
		const toolResult = msgs.find((m: { type: string }) => m.type === "tool_result");
		expect(toolResult.mergeable).toBe(true); // list_directory is mergeable

		// DB should have: user + assistant(tool_calls) + tool + assistant(text) (system prompt is dynamic, not stored)
		const sessionId = msgs.find((m: { type: string }) => m.type === "done").sessionId;
		const stored = getMessages(db, sessionId);
		expect(stored).toHaveLength(4);
		expect(stored[1].role).toBe("assistant");
		expect(stored[1].metadata).toBeTruthy(); // has tool_calls
		expect(stored[2].role).toBe("tool");
		expect(stored[2].metadata).toBeTruthy(); // has tool_call_id
		expect(stored[3].role).toBe("assistant");
		expect(stored[3].content).toBe("I see the files");
	});

	test("persists error message to DB on provider error", async () => {
		const ws = mockWs();
		const provider = failingProvider(429, "Rate limited");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done).toBeTruthy();
		expect(done.sessionId).toBeTruthy();

		const stored = getMessages(db, done.sessionId);
		// user + assistant(error) (system prompt is dynamic, not stored)
		expect(stored).toHaveLength(2);
		expect(stored[1].role).toBe("assistant");
		expect(stored[1].content).toContain("429");
	});

	test("persists partial messages and error on mid-stream failure", async () => {
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					throw new ProviderError(429, "Rate limited");
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "list files",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		// user + assistant(tool_calls) + tool(result) + assistant(error) (system prompt is dynamic, not stored)
		expect(stored).toHaveLength(4);
		expect(stored[1].role).toBe("assistant");
		expect(stored[1].metadata?.tool_calls).toBeTruthy();
		expect(stored[2].role).toBe("tool");
		expect(stored[3].role).toBe("assistant");
		expect(stored[3].content).toContain("429");
	});

	test("task tool is available in tool registry (subagent spawning)", async () => {
		// Provider that requests the "task" tool call
		let callCount = 0;
		const taskProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					// LLM tries to call the "task" tool
					yield { type: "tool_call_start", index: 0, id: "call_task", name: "task" };
					yield {
						type: "tool_call_delta",
						index: 0,
						arguments: JSON.stringify({
							description: "Test subagent",
							prompt: "Say hello",
						}),
					};
					yield { type: "finish", reason: "tool_calls" };
				} else if (callCount <= 3) {
					// Subagent title gen + agent loop calls
					yield { type: "text", text: "Hello from subagent" };
					yield { type: "finish", reason: "stop" };
				} else {
					// Parent continues
					yield { type: "text", text: "Subagent completed" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider: taskProvider,
			model: "test-model",
			text: "use subagent",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		// Should have a tool_call event for the task tool (not "Unknown tool")
		const toolCall = msgs.find((m: { type: string; id?: string }) => m.type === "tool_call" && m.id === "call_task");
		expect(toolCall).toBeTruthy();
		expect(toolCall.output).toContain("▸");

		// Should have a tool_result (not an "Unknown tool" error)
		const toolResult = msgs.find((m: { type: string; id?: string }) => m.type === "tool_result" && m.id === "call_task");
		expect(toolResult).toBeTruthy();

		// Child session events should carry sessionId (subagent event routing)
		const childTokens = msgs.filter((m: { type: string; sessionId?: string }) => m.type === "token" && m.sessionId);
		expect(childTokens.length).toBeGreaterThan(0);

		// Should complete with done
		expect(msgs.at(-1).type).toBe("done");
	});

	test("resume after error includes persisted messages in context", async () => {
		// First prompt: provider errors after tool call
		let callCount = 0;
		const failProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					throw new ProviderError(429, "Rate limited");
				}
			},
		};

		const ws1 = mockWs();
		await handlePrompt({
			ws: ws1,
			db,
			provider: failProvider,
			model: "test-model",
			text: "list files",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});
		const sessionId = ws1.messages().find((m: { type: string }) => m.type === "done").sessionId;

		// Second prompt: "resume" — provider succeeds
		const resumeProvider = capturingProvider(["Resuming where I left off"]);
		const ws2 = mockWs();
		await handlePrompt({
			ws: ws2,
			db,
			provider: resumeProvider,
			model: "test-model",
			text: "resume",
			sessionId,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		// Provider should see: system + user + assistant(tool_calls) + tool + assistant(error) + user("resume")
		const sentMessages = resumeProvider.captured[0].messages;
		expect(sentMessages.length).toBeGreaterThanOrEqual(6);
		expect(sentMessages.some((m: { role: string }) => m.role === "tool")).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: the content field exists on these message types
		expect(sentMessages.some((m: any) => m.content?.includes("429"))).toBe(true);
		// The second-to-last message before the agent loop adds its response should be the "resume" user message
		// Note: sentMessages includes the response added by the agent loop itself at the end
		expect(sentMessages.at(-2)?.content).toBe("resume");
	});

	test("persists staged skills as tool call/result pairs and sends prompt_echo", async () => {
		const provider = capturingProvider(["Got it"]);
		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "use skills",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
			stagedSkills: [
				{ name: "skill-a", content: "Content A" },
				{ name: "skill-b", content: "Content B" },
			],
		});

		// --- DB persistence checks ---
		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		// (assistant+tool for skill-a) + (assistant+tool for skill-b) + user + assistant (system prompt is dynamic, not stored)
		expect(stored).toHaveLength(6);

		// Skill A: assistant with tool_calls + tool result
		expect(stored[0].role).toBe("assistant");
		const skillAToolCalls = stored[0].metadata?.tool_calls as Array<{ id: string; function: { name: string } }>;
		expect(skillAToolCalls).toHaveLength(1);
		expect(skillAToolCalls[0].function.name).toBe("skill");
		expect(stored[1].role).toBe("tool");
		expect(stored[1].content).toContain("# Skill: skill-a");
		expect(stored[1].content).toContain("Content A");
		expect(stored[1].metadata?.tool_call_id).toBe(skillAToolCalls[0].id);
		expect(stored[1].metadata?.format_call).toBe("▸ Loading skill-a skill");
		expect(stored[1].metadata?.ui_output).toBe("▸ Loaded skill-a skill");
		expect(stored[1].metadata?.mergeable).toBe(true);

		// Skill B
		expect(stored[2].role).toBe("assistant");
		expect(stored[3].role).toBe("tool");
		expect(stored[3].content).toContain("# Skill: skill-b");

		// User message after skills
		expect(stored[4].role).toBe("user");
		expect(stored[4].content).toBe("use skills");

		// --- LLM receives skill content as tool messages ---
		const sentMessages = provider.captured[0].messages;
		// system + assistant(tool_calls A) + tool(A) + assistant(tool_calls B) + tool(B) + user + assistant(appended by loop)
		expect(sentMessages[0].role).toBe("system");
		expect(sentMessages[1].role).toBe("assistant");
		expect(sentMessages[2].role).toBe("tool");
		expect(sentMessages[2].content).toContain("Content A");
		expect(sentMessages[3].role).toBe("assistant");
		expect(sentMessages[4].role).toBe("tool");
		expect(sentMessages[4].content).toContain("Content B");
		expect(sentMessages[5].role).toBe("user");
		expect(sentMessages[5].content).toBe("use skills");

		// --- WebSocket event checks ---
		const msgs = ws.messages();

		// Should have tool_call + tool_result pairs for each skill
		const toolCalls = msgs.filter((m: { type: string }) => m.type === "tool_call");
		const toolResults = msgs.filter((m: { type: string }) => m.type === "tool_result");
		expect(toolCalls).toHaveLength(2);
		expect(toolResults).toHaveLength(2);
		expect(toolCalls[0].output).toBe("▸ Loading skill-a skill");
		expect(toolResults[0].output).toBe("▸ Loaded skill-a skill");
		expect(toolResults[0].mergeable).toBe(true);

		// Should have prompt_echo
		const echo = msgs.find((m: { type: string }) => m.type === "prompt_echo");
		expect(echo).toBeTruthy();
		expect(echo.text).toBe("use skills");

		// prompt_echo should come after tool events and before tokens
		const echoIdx = msgs.indexOf(echo);
		const lastToolResultIdx = msgs.lastIndexOf(toolResults[1]);
		const firstTokenIdx = msgs.findIndex((m: { type: string }) => m.type === "token");
		expect(echoIdx).toBeGreaterThan(lastToolResultIdx);
		expect(echoIdx).toBeLessThan(firstTokenIdx);
	});

	test("handles empty stagedSkills gracefully", async () => {
		const provider = capturingProvider(["Hello"]);
		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
			stagedSkills: [],
		});

		const sentMessages = provider.captured[0].messages;
		// No extra system messages — just system + user + assistant(appended by loop)
		expect(sentMessages[0].role).toBe("system");
		expect(sentMessages[1].role).toBe("user");
		expect(sentMessages[1].content).toBe("hi");
	});

	test("aborted prompt does not persist error message and sends done", async () => {
		const controller = new AbortController();

		// Provider that yields a tool call, during which the abort fires
		const slowProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
				yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
				yield { type: "finish", reason: "tool_calls" };
			},
		};

		// Pre-abort the controller. The agent-loop from Task 1 will
		// throw immediately at the top of the first iteration.
		controller.abort();

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider: slowProvider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
			signal: controller.signal,
		});

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done).toBeTruthy();
		expect(done.sessionId).toBeTruthy();

		// Should NOT have an error message sent to ws
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(0);

		// Should NOT have persisted an error assistant message
		const stored = getMessages(db, done.sessionId);
		const errorMsgs = stored.filter(
			(m: { role: string; content: string }) => m.role === "assistant" && m.content.startsWith("[Error:"),
		);
		expect(errorMsgs).toHaveLength(0);
	});

	test("sends actionable auth error for permanent AuthError (401)", async () => {
		const ws = mockWs();
		const provider = authFailingProvider(401, "Unauthorized", true, "github-copilot");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("bobai auth github-copilot");
	});

	test("uses the active provider id in permanent auth error guidance", async () => {
		const ws = mockWs();
		const provider = authFailingProvider(401, "Unauthorized", true, "opencode-go");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "kimi-k2.6",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("bobai auth opencode-go");
		expect(errors[0].message).not.toContain("bobai auth github-copilot");
	});

	test("sends network error message for transient AuthError", async () => {
		const ws = mockWs();
		const provider = authFailingProvider(0, "Token exchange network error: Unable to connect", false);
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		// Should NOT say "Unexpected error" — should reference the actual error
		expect(errors[0].message).not.toContain("Unexpected error");
		expect(errors[0].message).toMatch(/connect|network|token/i);
	});

	test("persists actionable auth error message to DB", async () => {
		const ws = mockWs();
		const provider = authFailingProvider(401, "Unauthorized", true, "opencode-go");
		await handlePrompt({
			ws,
			db,
			provider,
			model: "kimi-k2.6",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);
		const errorMsg = stored.find(
			(m: { role: string; content: string }) => m.role === "assistant" && m.content.startsWith("[Error:"),
		);
		expect(errorMsg).toBeTruthy();
		expect(errorMsg?.content).toContain("bobai auth opencode-go");
		expect(errorMsg?.content).not.toContain("bobai auth github-copilot");
	});

	test("staged skill llmContent includes base directory hint when skill is in registry", async () => {
		const skillRegistry: SkillRegistry = {
			get: (name) =>
				name === "writing"
					? {
							name: "writing",
							description: "Writing skill",
							content: "Write well.",
							filePath: "/home/user/.config/bobai/skills/writing/SKILL.md",
						}
					: undefined,
			list: () => [
				{
					name: "writing",
					description: "Writing skill",
					content: "Write well.",
					filePath: "/home/user/.config/bobai/skills/writing/SKILL.md",
				},
			],
		};

		const provider = capturingProvider(["OK"]);
		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "use writing",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: skillRegistry,
			stagedSkills: [{ name: "writing", content: "Write well." }],
		});

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		// The tool result for the staged skill should contain the base directory hint
		const skillToolMsg = stored.find(
			(m: { role: string; content: string }) => m.role === "tool" && m.content.includes("# Skill: writing"),
		);
		expect(skillToolMsg).toBeTruthy();
		expect(skillToolMsg?.content).toContain("Base directory: /home/user/.config/bobai/skills/writing");
		expect(skillToolMsg?.content).toContain("Source: /home/user/.config/bobai/skills/writing/SKILL.md");
	});

	test("new session emits session_created before any token message", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "hi",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();

		// Should have a session_created message
		const sessionCreated = msgs.find((m: { type: string }) => m.type === "session_created");
		expect(sessionCreated).toBeTruthy();
		expect(sessionCreated.sessionId).toBeTruthy();

		// session_created should come before any token message
		const sessionCreatedIdx = msgs.indexOf(sessionCreated);
		const firstTokenIdx = msgs.findIndex((m: { type: string }) => m.type === "token");
		expect(firstTokenIdx).toBeGreaterThan(-1); // tokens exist
		expect(sessionCreatedIdx).toBeLessThan(firstTokenIdx);

		// session_created sessionId should match done sessionId
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(sessionCreated.sessionId).toBe(done.sessionId);
	});

	test("existing session does NOT emit session_created", async () => {
		// First prompt — creates a session
		const ws1 = mockWs();
		const provider1 = mockProvider(["first"]);
		await handlePrompt({
			ws: ws1,
			db,
			provider: provider1,
			model: "test-model",
			text: "first",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});
		const sessionId = ws1.messages().find((m: { type: string }) => m.type === "done").sessionId;

		// Second prompt — reuses existing session
		const ws2 = mockWs();
		const provider2 = mockProvider(["second"]);
		await handlePrompt({
			ws: ws2,
			db,
			provider: provider2,
			model: "test-model",
			text: "second",
			sessionId,
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws2.messages();
		const sessionCreated = msgs.find((m: { type: string }) => m.type === "session_created");
		expect(sessionCreated).toBeUndefined();
	});
});
