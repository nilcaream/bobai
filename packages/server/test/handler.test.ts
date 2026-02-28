import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";
import { getMessages } from "../src/session/repository";
import { createTestDb } from "./helpers";

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
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", projectRoot: "/tmp" });

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done.sessionId).toBeTruthy();
	});

	test("streams tokens then done with sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["Hello", " world"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", projectRoot: "/tmp" });

		const msgs = ws.messages();
		const tokens = msgs.filter((m: { type: string }) => m.type === "token");
		expect(tokens).toEqual([
			{ type: "token", text: "Hello" },
			{ type: "token", text: " world" },
		]);
		expect(msgs.at(-1).type).toBe("done");
		expect(msgs.at(-1).sessionId).toBeTruthy();
	});

	test("persists user and assistant messages to DB", async () => {
		const ws = mockWs();
		const provider = mockProvider(["response text"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "my question", projectRoot: "/tmp" });

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		expect(stored).toHaveLength(3); // system + user + assistant
		expect(stored[0].role).toBe("system");
		expect(stored[1].role).toBe("user");
		expect(stored[1].content).toBe("my question");
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].content).toBe("response text");
	});

	test("resumes existing session with sessionId", async () => {
		const ws1 = mockWs();
		const provider1 = mockProvider(["first response"]);
		await handlePrompt({ ws: ws1, db, provider: provider1, model: "test-model", text: "first", projectRoot: "/tmp" });
		const sessionId = ws1.messages().find((m: { type: string }) => m.type === "done").sessionId;

		const ws2 = mockWs();
		const provider2 = capturingProvider(["second response"]);
		await handlePrompt({
			ws: ws2,
			db,
			provider: provider2,
			model: "test-model",
			text: "second",
			sessionId,
			projectRoot: "/tmp",
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

		// DB should have 5 messages total
		const stored = getMessages(db, sessionId);
		expect(stored).toHaveLength(5); // system + user1 + assistant1 + user2 + assistant2
	});

	test("sends error for unknown sessionId", async () => {
		const ws = mockWs();
		const provider = mockProvider(["x"]);
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", sessionId: "nonexistent", projectRoot: "/tmp" });

		const msgs = ws.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].type).toBe("error");
		expect(msgs[0].message).toContain("not found");
	});

	test("sends error on ProviderError", async () => {
		const ws = mockWs();
		const provider = failingProvider(401, "Unauthorized");
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", projectRoot: "/tmp" });

		const msgs = ws.messages();
		const errors = msgs.filter((m: { type: string }) => m.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("401");
	});

	test("sends tokens and error when provider errors mid-stream", async () => {
		const ws = mockWs();
		const provider = partialFailingProvider(["Hello", " wor"], 500, "Internal Server Error");
		await handlePrompt({ ws, db, provider, model: "test-model", text: "tell me something", projectRoot: "/tmp" });

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
		await handlePrompt({ ws, db, provider: toolProvider, model: "test-model", text: "what files?", projectRoot: "/tmp" });

		const msgs = ws.messages();
		// Should have tool_call, tool_result, text token(s), and done
		expect(msgs.some((m: { type: string }) => m.type === "tool_call")).toBe(true);
		expect(msgs.some((m: { type: string }) => m.type === "tool_result")).toBe(true);
		expect(msgs.at(-1).type).toBe("done");

		// DB should have: system + user + assistant(tool_calls) + tool + assistant(text)
		const sessionId = msgs.find((m: { type: string }) => m.type === "done").sessionId;
		const stored = getMessages(db, sessionId);
		expect(stored).toHaveLength(5);
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].metadata).toBeTruthy(); // has tool_calls
		expect(stored[3].role).toBe("tool");
		expect(stored[3].metadata).toBeTruthy(); // has tool_call_id
		expect(stored[4].role).toBe("assistant");
		expect(stored[4].content).toBe("I see the files");
	});

	test("persists error message to DB on provider error", async () => {
		const ws = mockWs();
		const provider = failingProvider(429, "Rate limited");
		await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", projectRoot: "/tmp" });

		const msgs = ws.messages();
		const done = msgs.find((m: { type: string }) => m.type === "done");
		expect(done).toBeTruthy();
		expect(done.sessionId).toBeTruthy();

		const stored = getMessages(db, done.sessionId);
		// system + user + assistant(error)
		expect(stored).toHaveLength(3);
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].content).toContain("429");
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
		await handlePrompt({ ws, db, provider, model: "test-model", text: "list files", projectRoot: "/tmp" });

		const done = ws.messages().find((m: { type: string }) => m.type === "done");
		const stored = getMessages(db, done.sessionId);

		// system + user + assistant(tool_calls) + tool(result) + assistant(error)
		expect(stored).toHaveLength(5);
		expect(stored[2].role).toBe("assistant");
		expect(stored[2].metadata?.tool_calls).toBeTruthy();
		expect(stored[3].role).toBe("tool");
		expect(stored[4].role).toBe("assistant");
		expect(stored[4].content).toContain("429");
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
		await handlePrompt({ ws: ws1, db, provider: failProvider, model: "test-model", text: "list files", projectRoot: "/tmp" });
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
});
