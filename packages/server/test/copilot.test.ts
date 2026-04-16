import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredAuth } from "../src/auth/store";
import { createCopilotProvider, isCopilotClaude } from "../src/provider/copilot";
import type { StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

function makeAuth(access = "tok"): StoredAuth {
	return { refresh: "gho_testauthrefreshtoken1234567890abcdef", access, expires: Date.now() + 3_600_000 };
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
	const text = events.map((e) => `data: ${e}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function chatChunk(content: string): string {
	return JSON.stringify({ choices: [{ delta: { content } }] });
}

describe("CopilotProvider", () => {
	const originalFetch = globalThis.fetch;
	let emptyConfigDir: string;

	beforeEach(() => {
		emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-copilot-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(emptyConfigDir, { recursive: true, force: true });
	});

	test("has correct id", () => {
		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		expect(provider.id).toBe("github-copilot");
	});

	test("sends correct request to Copilot API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), emptyConfigDir);
		const tokens: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hello" }],
		})) {
			tokens.push(t);
		}

		expect(capturedUrl).toBe("https://api.individual.githubcopilot.com/chat/completions");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-token");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
		expect(headers["User-Agent"]).toMatch(/^GitHubCopilotChat\//);
		expect(headers["x-initiator"]).toBe("user");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("gpt-5-mini");
		expect(body.stream).toBe(true);
	});

	test("yields content tokens from SSE stream", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(sseStream([chatChunk("Hello"), chatChunk(" world"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("throws ProviderError on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("bad-token"), emptyConfigDir);
		const iter = provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		});

		expect(async () => {
			for await (const _ of iter) {
				/* drain */
			}
		}).toThrow(ProviderError);
	});

	test("skips chunks with no delta content", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(sseStream([JSON.stringify({ choices: [{ delta: {} }] }), chatChunk("only"), "[DONE]"]), {
				status: 200,
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "only" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("uses default headers", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toMatch(/^GitHubCopilotChat\//);
	});

	test("includes tools in request body when provided", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		const tools = [
			{
				type: "function" as const,
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		];
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
			tools,
		})) {
			/* drain */
		}

		const body = JSON.parse(capturedInit?.body as string);
		expect(body.tools).toEqual(tools);
	});

	test("does not include tools in request body when not provided", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const body = JSON.parse(capturedInit?.body as string);
		expect(body.tools).toBeUndefined();
	});

	test("parses delta.tool_calls into tool_call_start and tool_call_delta events", async () => {
		const chunks = [
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_abc123", type: "function", function: { name: "read_file", arguments: "" } }],
						},
					},
				],
			}),
			JSON.stringify({
				choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }],
			}),
			JSON.stringify({
				choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"src/index.ts"}' } }] } }],
			}),
			JSON.stringify({
				choices: [{ finish_reason: "tool_calls", delta: {} }],
			}),
			"[DONE]",
		];

		globalThis.fetch = mock(async () => {
			return new Response(sseStream(chunks), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "tool_call_start", index: 0, id: "call_abc123", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"path"' },
			{ type: "tool_call_delta", index: 0, arguments: ':"src/index.ts"}' },
			{ type: "usage", tokenCount: 0, tokenLimit: 0, display: "gpt-4o | 0x | 0 tokens" },
			{ type: "finish", reason: "tool_calls" },
		]);
	});

	test("yields finish with reason 'stop' for normal text completion", async () => {
		globalThis.fetch = mock(async () => {
			const chunks = [
				JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
				JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }] }),
				"[DONE]",
			];
			return new Response(sseStream(chunks), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "usage", tokenCount: 0, tokenLimit: 0, display: "gpt-4o | 0x | 0 tokens" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("sets x-initiator to agent when last message is not from user", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["x-initiator"]).toBe("agent");
	});

	test("yields usage event from final SSE chunk", async () => {
		const configDir = path.join(__dirname, "copilot-config-usage.tmp");
		fs.mkdirSync(configDir, { recursive: true });
		try {
			const modelsConfig = [
				{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64000, maxOutput: 4096, premiumRequestMultiplier: 1, enabled: true },
			];
			fs.writeFileSync(path.join(configDir, "copilot-models.json"), JSON.stringify(modelsConfig));

			const chunks = [
				chatChunk("Hello"),
				JSON.stringify({
					choices: [{ finish_reason: "stop", delta: {} }],
					usage: { prompt_tokens: 895, completion_tokens: 37, total_tokens: 932 },
				}),
				"[DONE]",
			];

			globalThis.fetch = mock(async () => {
				return new Response(sseStream(chunks), { status: 200 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth(), configDir);
			const events: StreamEvent[] = [];
			for await (const t of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(t);
			}

			expect(events).toEqual([
				{ type: "text", text: "Hello" },
				{ type: "usage", tokenCount: 895, tokenLimit: 64000, display: "gpt-4o | 0x | 895 / 64000 | 1%" },
				{ type: "finish", reason: "stop" },
			]);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("yields usage with tokenLimit 0 when no config file exists", async () => {
		const configDir = path.join(__dirname, "copilot-config-empty.tmp");
		fs.mkdirSync(configDir, { recursive: true });
		try {
			// No config file written — directory is empty

			const chunks = [
				chatChunk("Hi"),
				JSON.stringify({
					choices: [{ finish_reason: "stop", delta: {} }],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				}),
				"[DONE]",
			];

			globalThis.fetch = mock(async () => {
				return new Response(sseStream(chunks), { status: 200 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth(), configDir);
			const events: StreamEvent[] = [];
			for await (const t of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(t);
			}

			expect(events).toEqual([
				{ type: "text", text: "Hi" },
				{ type: "usage", tokenCount: 100, tokenLimit: 0, display: "gpt-4o | 0x | 100 tokens" },
				{ type: "finish", reason: "stop" },
			]);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("uses initiator override when provided", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), emptyConfigDir);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
			initiator: "agent",
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		// Last message is user, but initiator override is "agent"
		expect(headers["x-initiator"]).toBe("agent");
	});

	test("auto-refreshes expired session token before streaming", async () => {
		const configDir = path.join(__dirname, "copilot-refresh-auto.tmp");
		fs.mkdirSync(configDir, { recursive: true });
		try {
			const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

			globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = url.toString();
				fetchCalls.push({ url: urlStr, headers: { ...(init?.headers as Record<string, string>) } });

				if (urlStr.includes("copilot_internal/v2/token")) {
					return new Response(
						JSON.stringify({
							token: "tid=new;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
							expires_at: Math.floor(Date.now() / 1000) + 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
			}) as typeof fetch;

			const provider = createCopilotProvider(
				{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "expired-tok", expires: Date.now() - 1000 },
				configDir,
			);

			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}

			// First call should be token exchange, second should be chat completions
			expect(fetchCalls[0].url).toContain("copilot_internal/v2/token");
			expect(fetchCalls[0].headers.Authorization).toBe("Bearer gho_testauthrefreshtoken1234567890abcdef");
			expect(fetchCalls[1].url).toContain("chat/completions");
			expect(fetchCalls[1].headers.Authorization).toContain("tid=new");

			// Should persist the refreshed auth
			const saved = JSON.parse(fs.readFileSync(path.join(configDir, "auth.json"), "utf8"));
			expect(saved.refresh).toBe("gho_testauthrefreshtoken1234567890abcdef");
			expect(saved.access).toContain("tid=new");
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("does not exchange token when session is still valid", async () => {
		const fetchCalls: string[] = [];

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			fetchCalls.push(url.toString());
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("valid-tok"), emptyConfigDir);

		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		// Should only have one call (chat completions), no token exchange
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]).toContain("chat/completions");
	});

	test("uses dynamic base URL from token proxy-ep", async () => {
		let capturedUrl = "";

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			capturedUrl = url.toString();
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const auth: StoredAuth = {
			refresh: "gho_testauthrefreshtoken1234567890abcdef",
			access: "tid=x;proxy-ep=proxy.custom.example.com",
			expires: Date.now() + 3_600_000,
		};
		const provider = createCopilotProvider(auth, emptyConfigDir);

		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(capturedUrl).toBe("https://api.custom.example.com/chat/completions");
	});
});

// ── Turn tracking: beginTurn / getTurnSummary ─────────────────────────────

describe("Turn tracking", () => {
	const originalFetch = globalThis.fetch;
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-turn-"));
		const modelsConfig = [
			{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64000, maxOutput: 4096, premiumRequestMultiplier: 1, enabled: true },
		];
		fs.writeFileSync(path.join(configDir, "copilot-models.json"), JSON.stringify(modelsConfig));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	/** Helper: mock fetch returning a single completion with the given usage. */
	function mockFetchWithUsage(promptTokens: number, completionTokens: number) {
		globalThis.fetch = mock(async () => {
			const chunks = [
				chatChunk("ok"),
				JSON.stringify({
					choices: [{ finish_reason: "stop", delta: {} }],
					usage: {
						prompt_tokens: promptTokens,
						completion_tokens: completionTokens,
						total_tokens: promptTokens + completionTokens,
					},
				}),
				"[DONE]",
			];
			return new Response(sseStream(chunks), { status: 200 });
		}) as typeof fetch;
	}

	/** Drain a provider stream, collecting all events. */
	async function drain(provider: ReturnType<typeof createCopilotProvider>, model = "gpt-4o") {
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model,
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}
		return events;
	}

	test("subagent session (beginTurn(0)) shows absolute context", async () => {
		mockFetchWithUsage(3500, 200);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.(0);
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		// Should show "context: 3500" (absolute, no sign)
		expect(summary).toContain("context: 3500");
		expect(summary).not.toMatch(/context: [+-]3500/);
	});

	test("subagent session (beginTurn()) with no argument shows absolute context", async () => {
		mockFetchWithUsage(2000, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.();
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		// No sessionPromptTokens → baselineTokens is 0 → absolute display
		expect(summary).toContain("context: 2000");
	});

	test("parent session (beginTurn(5000)) shows context delta with sign", async () => {
		mockFetchWithUsage(5800, 300);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.(5000);
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		// Delta: 5800 - 5000 = +800
		expect(summary).toContain("context: +800");
	});

	test("parent session shows negative delta when context shrinks", async () => {
		mockFetchWithUsage(4200, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.(5000);
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		// Delta: 4200 - 5000 = -800
		expect(summary).toContain("context: -800");
	});

	test("parent session shows zero delta without sign", async () => {
		mockFetchWithUsage(5000, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.(5000);
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		// Delta: 5000 - 5000 = 0
		expect(summary).toContain("context: 0");
		expect(summary).not.toMatch(/context: [+-]0/);
	});

	test("beginTurn resets turnLastCallTokens so prior parent state does not leak", async () => {
		// Simulate the original bug: parent accumulates tokens, then subagent starts
		mockFetchWithUsage(41965, 500);
		const provider = createCopilotProvider(makeAuth(), configDir);

		// Parent turn
		provider.beginTurn?.(30000);
		await drain(provider);
		expect(provider.getTurnPromptTokens?.()).toBe(41965);

		// Now a subagent starts — save parent, begin subagent turn
		const saved = provider.saveTurnState?.();
		provider.beginTurn?.(0);

		// Subagent makes a call
		mockFetchWithUsage(3500, 200);
		await drain(provider);

		const subSummary = provider.getTurnSummary?.();
		// Subagent should show absolute "context: 3500", NOT "context: -38465"
		expect(subSummary).toContain("context: 3500");
		expect(subSummary).not.toMatch(/context: [+-]/);

		// Restore parent state
		provider.restoreTurnState?.(saved);
		const parentSummary = provider.getTurnSummary?.();
		// Parent should still show its own delta: 41965 - 30000 = +11965
		expect(parentSummary).toContain("context: +11965");
	});

	test("getTurnSummary returns undefined when no turn has started", () => {
		const provider = createCopilotProvider(makeAuth(), configDir);
		expect(provider.getTurnSummary?.()).toBeUndefined();
	});

	test("getTurnSummary includes all expected fields", async () => {
		mockFetchWithUsage(1000, 50);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn?.(0);
		await drain(provider);

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		expect(summary).toContain("gpt-4o");
		expect(summary).toContain("agent: 0");
		expect(summary).toContain("user: 1");
		expect(summary).toContain("premium:");
		expect(summary).toContain("tokens: 1050");
		expect(summary).toContain("context: 1000");
		expect(summary).toMatch(/\d+\.\d+s/);
	});
});

// ── Token refresh coalescing ──────────────────────────────────────────────

describe("Token refresh coalescing", () => {
	const originalFetch = globalThis.fetch;
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-coalesce-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("concurrent streams with expired token trigger only one token exchange", async () => {
		let tokenExchangeCount = 0;

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr = url.toString();

			if (urlStr.includes("copilot_internal/v2/token")) {
				tokenExchangeCount++;
				// Simulate network delay so concurrent callers overlap
				await new Promise((r) => setTimeout(r, 50));
				return new Response(
					JSON.stringify({
						token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(
			{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "expired-tok", expires: Date.now() - 1000 },
			configDir,
		);

		// Fire two streams concurrently — both will find the token expired
		const stream1 = (async () => {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "a" }],
			})) {
				/* drain */
			}
		})();

		const stream2 = (async () => {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "b" }],
			})) {
				/* drain */
			}
		})();

		await Promise.all([stream1, stream2]);

		// Only ONE token exchange should have happened
		expect(tokenExchangeCount).toBe(1);
	});

	test("failed token refresh resets coalescing so next caller retries", async () => {
		let tokenExchangeCount = 0;

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr = url.toString();

			if (urlStr.includes("copilot_internal/v2/token")) {
				tokenExchangeCount++;
				if (tokenExchangeCount === 1) {
					return new Response("Server Error", { status: 500 });
				}
				return new Response(
					JSON.stringify({
						token: "tid=recovered;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(
			{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "expired-tok", expires: Date.now() - 1000 },
			configDir,
		);

		// First attempt should fail (500)
		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "a" }],
			})) {
				/* drain */
			}
		} catch {
			// Expected: token exchange failed
		}

		// Second attempt should succeed — coalescing promise was cleared
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "b" }],
		})) {
			events.push(e);
		}

		expect(tokenExchangeCount).toBe(2);
		expect(events.some((e) => e.type === "text")).toBe(true);
	});
});

// ── ensureValidSession logging ────────────────────────────────────────────

describe("ensureValidSession logging", () => {
	const originalFetch = globalThis.fetch;
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-session-log-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("logs token refresh trigger and success with token details", async () => {
		const logs: string[] = [];
		const logger = {
			level: "debug" as const,
			logDir: "",
			debug: (_s: string, m: string) => logs.push(`debug: ${m}`),
			info: (_s: string, m: string) => logs.push(`info: ${m}`),
			warn: (_s: string, m: string) => logs.push(`warn: ${m}`),
			error: (_s: string, m: string) => logs.push(`error: ${m}`),
		};

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=new;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(
			{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "expired-tok", expires: Date.now() - 1000 },
			configDir,
			logger,
		);

		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(logs.some((l) => l.includes("refresh"))).toBe(true);
		expect(logs.some((l) => l.includes("success") || l.includes("refreshed"))).toBe(true);
		// New: verify token summary details are logged
		expect(logs.some((l) => l.includes("type=oauth") && l.includes("gho_"))).toBe(true);
		expect(logs.some((l) => l.includes("baseUrl="))).toBe(true);
	});

	test("logs token refresh failure", async () => {
		const logs: string[] = [];
		const logger = {
			level: "debug" as const,
			logDir: "",
			debug: (_s: string, m: string) => logs.push(`debug: ${m}`),
			info: (_s: string, m: string) => logs.push(`info: ${m}`),
			warn: (_s: string, m: string) => logs.push(`warn: ${m}`),
			error: (_s: string, m: string) => logs.push(`error: ${m}`),
		};

		globalThis.fetch = mock(async () => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		const provider = createCopilotProvider(
			{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "expired-tok", expires: Date.now() - 1000 },
			configDir,
			logger,
		);

		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}
		} catch {
			// expected
		}

		expect(logs.some((l) => l.includes("fail") || l.includes("error"))).toBe(true);
	});

	test("logs diagnostic details on 400 auth retry", async () => {
		const logs: string[] = [];
		const logger = {
			level: "debug" as const,
			logDir: "",
			debug: (_s: string, m: string) => logs.push(`debug: ${m}`),
			info: (_s: string, m: string) => logs.push(`info: ${m}`),
			warn: (_s: string, m: string) => logs.push(`warn: ${m}`),
			error: (_s: string, m: string) => logs.push(`error: ${m}`),
		};

		let chatAttempt = 0;

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr = url.toString();

			if (urlStr.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			chatAttempt++;
			if (chatAttempt === 1) {
				return new Response("Authorization header is badly formatted", { status: 400 });
			}
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("stale-session"), configDir, logger);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		// Should log the 400 with body excerpt and token details
		expect(logs.some((l) => l.includes("Got 400") && l.includes("badly formatted"))).toBe(true);
		expect(logs.some((l) => l.includes("session=") && l.includes("baseUrl="))).toBe(true);
	});
});

// ── Retry logic ───────────────────────────────────────────────────────────

describe("Retry logic", () => {
	const originalFetch = globalThis.fetch;
	const fast = { backoffBaseMs: 10 };
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-retry-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("retries on 5xx and succeeds", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			if (attempt <= 2) {
				return new Response("Internal Server Error", { status: 500 });
			}
			return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(3);
		expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
	});

	test("retries on 429 and succeeds", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			if (attempt === 1) {
				return new Response("Rate limited", { status: 429 });
			}
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(2);
		expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
	});

	test("does not retry on 4xx other than 400, 401, 429", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir);

		let caught: unknown;
		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}
		} catch (err) {
			caught = err;
		}

		expect(attempt).toBe(1);
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).status).toBe(403);
	});

	test("retries on timeout (fetch throws) and succeeds", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
			attempt++;
			if (attempt <= 1) {
				// Simulate a timeout by aborting via the signal
				const error = new DOMException("The operation timed out", "TimeoutError");
				throw error;
			}
			return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(2);
		expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
	});

	test("throws after exhausting all retries on 5xx", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			return new Response("Server Error", { status: 502 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);

		let caught: unknown;
		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}
		} catch (err) {
			caught = err;
		}

		// 1 initial + 3 retries = 4 total attempts
		expect(attempt).toBe(4);
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).status).toBe(502);
	});

	test("does not retry when caller's abort signal fires", async () => {
		let attempt = 0;
		const controller = new AbortController();

		globalThis.fetch = mock(async () => {
			attempt++;
			// Abort the caller signal to simulate user cancellation
			controller.abort();
			throw new DOMException("The operation was aborted", "AbortError");
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);

		let caught: unknown;
		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
				signal: controller.signal,
			})) {
				/* drain */
			}
		} catch (err) {
			caught = err;
		}

		// Should NOT retry — caller aborted
		expect(attempt).toBe(1);
		expect(caught).toBeDefined();
	});

	test("calls ensureValidSession before each retry", async () => {
		let attempt = 0;
		const capturedTokens: string[] = [];

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = url.toString();

			if (urlStr.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=refreshed;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			attempt++;
			const headers = init?.headers as Record<string, string>;
			capturedTokens.push(headers?.Authorization ?? "");

			if (attempt === 1) {
				return new Response("Server Error", { status: 500 });
			}
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		// Start with a token that will expire during backoff
		const provider = createCopilotProvider(
			{ refresh: "gho_testauthrefreshtoken1234567890abcdef", access: "tid=original", expires: Date.now() + 100 },
			configDir,
			undefined,
			fast,
		);

		// Small delay to let the token expire before retry
		await new Promise((r) => setTimeout(r, 150));

		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(2);
		// First request used original token (via initial ensureValidSession which refreshed because expired)
		// After 500, backoff + ensureValidSession before retry
		// Both should have a Bearer token
		expect(capturedTokens.length).toBe(2);
		expect(capturedTokens.every((t) => t.startsWith("Bearer "))).toBe(true);
	});

	test("slow SSE body stream is not killed by connection timeout", async () => {
		// The connection timeout (60s) should only cover waiting for headers.
		// Once headers arrive the timeout is cleared, so even a slow body
		// stream should complete without being aborted.
		globalThis.fetch = mock(async () => {
			// Headers arrive immediately, but the body drips slowly.
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode(`data: ${chatChunk("slow")}\n\n`));
					// Simulate a slow generation — 200ms pause between chunks.
					// This is well within 60s but proves the body is not governed
					// by the connection timeout timer.
					await new Promise((r) => setTimeout(r, 200));
					controller.enqueue(encoder.encode(`data: ${chatChunk(" but steady")}\n\n`));
					await new Promise((r) => setTimeout(r, 200));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		// Both chunks should arrive — the body was not aborted
		expect(events).toEqual([
			{ type: "text", text: "slow" },
			{ type: "text", text: " but steady" },
			{ type: "finish", reason: "stop" },
		]);
	});

	test("retries once on 401 from chat/completions with forced token refresh", async () => {
		let chatAttempt = 0;
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-401-retry-"));

		try {
			globalThis.fetch = mock(async (url: string | URL | Request, _init?: RequestInit) => {
				const urlStr = url.toString();

				if (urlStr.includes("copilot_internal/v2/token")) {
					return new Response(
						JSON.stringify({
							token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
							expires_at: Math.floor(Date.now() / 1000) + 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				chatAttempt++;
				if (chatAttempt === 1) {
					// First chat/completions call returns 401 (server revoked token early)
					return new Response("Unauthorized", { status: 401 });
				}
				// Second call with refreshed token succeeds
				return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth("stale-token"), configDir);
			const events: StreamEvent[] = [];
			for await (const e of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(e);
			}

			expect(chatAttempt).toBe(2);
			expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("does not retry 401 from chat/completions more than once", async () => {
		let chatAttempt = 0;
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-401-noretry-"));

		try {
			globalThis.fetch = mock(async (url: string | URL | Request) => {
				const urlStr = url.toString();

				if (urlStr.includes("copilot_internal/v2/token")) {
					return new Response(
						JSON.stringify({
							token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
							expires_at: Math.floor(Date.now() / 1000) + 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				chatAttempt++;
				return new Response("Unauthorized", { status: 401 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth("stale-token"), configDir);
			let caught: unknown;
			try {
				for await (const _ of provider.stream({
					model: "gpt-4o",
					messages: [{ role: "user", content: "hi" }],
				})) {
					/* drain */
				}
			} catch (err) {
				caught = err;
			}

			// Should try once, force refresh, try again, then fail
			expect(chatAttempt).toBe(2);
			expect(caught).toBeInstanceOf(ProviderError);
			expect((caught as ProviderError).status).toBe(401);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("retries once on 400 from chat/completions with forced token refresh", async () => {
		let chatAttempt = 0;
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-400-retry-"));

		try {
			globalThis.fetch = mock(async (url: string | URL | Request, _init?: RequestInit) => {
				const urlStr = url.toString();

				if (urlStr.includes("copilot_internal/v2/token")) {
					return new Response(
						JSON.stringify({
							token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
							expires_at: Math.floor(Date.now() / 1000) + 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				chatAttempt++;
				if (chatAttempt === 1) {
					return new Response("Authorization header is badly formatted", { status: 400 });
				}
				return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth("stale-token"), configDir);
			const events: StreamEvent[] = [];
			for await (const e of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(e);
			}

			expect(chatAttempt).toBe(2);
			expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("does not retry 400 from chat/completions more than once", async () => {
		let chatAttempt = 0;
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-400-noretry-"));

		try {
			globalThis.fetch = mock(async (url: string | URL | Request) => {
				const urlStr = url.toString();

				if (urlStr.includes("copilot_internal/v2/token")) {
					return new Response(
						JSON.stringify({
							token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
							expires_at: Math.floor(Date.now() / 1000) + 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				chatAttempt++;
				return new Response("Authorization header is badly formatted", { status: 400 });
			}) as typeof fetch;

			const provider = createCopilotProvider(makeAuth("stale-token"), configDir);
			let caught: unknown;
			try {
				for await (const _ of provider.stream({
					model: "gpt-4o",
					messages: [{ role: "user", content: "hi" }],
				})) {
					/* drain */
				}
			} catch (err) {
				caught = err;
			}

			// Should try once, force refresh, try again, then fail
			expect(chatAttempt).toBe(2);
			expect(caught).toBeInstanceOf(ProviderError);
			expect((caught as ProviderError).status).toBe(400);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("retries when SSE body stalls after headers arrive (OpenAI)", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			attempt++;
			if (attempt === 1) {
				// Return 200 with a ReadableStream that never enqueues data (stalls).
				// Wire the abort signal so the stream errors when our timer fires,
				// matching real fetch() behaviour.
				const signal = init?.signal;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						if (signal) {
							signal.addEventListener("abort", () =>
								controller.error(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
							);
						}
						// intentionally never enqueue or close — simulates stall
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			// Attempt 2: normal success
			return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 50,
		});
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(2);
		expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
	});

	test("body timeout resets on each SSE chunk (OpenAI)", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			// Return 200 with a slow stream — chunks arrive every 80ms
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const encoder = new TextEncoder();
					const chunks = [chatChunk("a"), chatChunk("b"), chatChunk("c"), "[DONE]"];
					for (const chunk of chunks) {
						await new Promise((r) => setTimeout(r, 80));
						controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 200,
		});
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		// All chunks received, no retry
		expect(attempt).toBe(1);
		expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(["a", "b", "c"]);
	});

	test("retries when SSE body stalls after headers arrive (Anthropic)", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			// Skip token exchange calls
			if (url.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			attempt++;
			if (attempt === 1) {
				// Return 200 with a stream that stalls after headers.
				// Wire the abort signal so the stream errors when our timer fires.
				const signal = init?.signal;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						if (signal) {
							signal.addEventListener("abort", () =>
								controller.error(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
							);
						}
						// intentionally never enqueue or close — simulates stall
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			// Attempt 2: normal Anthropic success
			return new Response(anthropicTextResponse("recovered from stall"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 50,
		});
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		expect(attempt).toBe(2);
		expect(events.some((e) => e.type === "text" && e.text === "recovered from stall")).toBe(true);
	});

	test("flat backoff waits the same delay between retries", async () => {
		let attempt = 0;
		const timestamps: number[] = [];

		globalThis.fetch = mock(async () => {
			attempt++;
			timestamps.push(performance.now());
			if (attempt <= 3) {
				return new Response("Server Error", { status: 503 });
			}
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(attempt).toBe(4);
		// Verify backoff is flat: all gaps should be approximately equal
		// With backoffBaseMs=10: all delays are 10ms
		const gap1 = timestamps[1] - timestamps[0];
		const gap2 = timestamps[2] - timestamps[1];
		const gap3 = timestamps[3] - timestamps[2];

		expect(gap1).toBeGreaterThan(5);
		expect(gap2).toBeGreaterThan(5);
		expect(gap3).toBeGreaterThan(5);
		// No gap should be more than double another (flat, not exponential)
		expect(Math.max(gap1, gap2, gap3)).toBeLessThan(Math.min(gap1, gap2, gap3) * 3);
	});

	test("downgrades x-initiator to agent on retry (OpenAI)", async () => {
		const capturedInitiators: string[] = [];
		let attempt = 0;

		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			attempt++;
			const headers = init?.headers as Record<string, string> | undefined;
			if (headers?.["x-initiator"]) {
				capturedInitiators.push(headers["x-initiator"]);
			}
			if (attempt === 1) {
				return new Response("Server Error", { status: 500 });
			}
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		for await (const _e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(capturedInitiators[0]).toBe("user");
		expect(capturedInitiators[1]).toBe("agent");
	});

	test("does not log downgrade when initiator was already agent", async () => {
		const logs: string[] = [];
		const testLogger = {
			debug: () => {},
			info: () => {},
			warn: (_tag: string, msg: string) => logs.push(msg),
			error: () => {},
		};
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			if (attempt === 1) return new Response("Error", { status: 500 });
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, testLogger, fast);
		for await (const _e of provider.stream({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function" as const, function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", content: "done", tool_call_id: "c1" },
			],
		})) {
			/* drain */
		}

		// Initiator was "agent" (last message is tool), so no downgrade warning
		expect(logs.some((l) => l.includes("x-initiator"))).toBe(false);
	});

	test("logs warning when x-initiator downgraded from user to agent on retry", async () => {
		const logs: string[] = [];
		const testLogger = {
			debug: () => {},
			info: () => {},
			warn: (_tag: string, msg: string) => logs.push(msg),
			error: () => {},
		};
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			if (attempt === 1) return new Response("Error", { status: 500 });
			return new Response(sseStream([chatChunk("ok"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, testLogger, fast);
		for await (const _e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		// Should log exactly one downgrade warning
		expect(logs.filter((l) => l.includes("x-initiator")).length).toBe(1);
	});

	test("downgrades x-initiator to agent on retry (Anthropic)", async () => {
		const capturedInitiators: string[] = [];
		let attempt = 0;

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			attempt++;
			let initiatorValue: string | null = null;
			if (init?.headers instanceof Headers) {
				initiatorValue = init.headers.get("x-initiator");
			} else if (init?.headers) {
				initiatorValue = (init.headers as Record<string, string>)["x-initiator"] ?? null;
			} else if (input instanceof Request) {
				initiatorValue = input.headers.get("x-initiator");
			}
			if (initiatorValue) {
				capturedInitiators.push(initiatorValue);
			}

			if (attempt === 1) {
				return new Response(JSON.stringify({ error: { message: "Server Error" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, fast);
		for await (const _e of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(capturedInitiators[0]).toBe("user");
		expect(capturedInitiators[1]).toBe("agent");
	});

	test("throws TimeoutError when all retries exhaust due to body timeout (OpenAI)", async () => {
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					if (signal) {
						signal.addEventListener("abort", () =>
							controller.error(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
						);
					}
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 50,
		});

		let caught: unknown;
		try {
			for await (const _ of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeDefined();
		expect((caught as Error).name).toBe("TimeoutError");
		expect((caught as Error).message).toContain("timed out after 4 attempt");
	});

	test("throws TimeoutError when all retries exhaust due to body timeout (Anthropic)", async () => {
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			const signal = init?.signal;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					if (signal) {
						signal.addEventListener("abort", () =>
							controller.error(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
						);
					}
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), configDir, undefined, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 50,
		});

		let caught: unknown;
		try {
			for await (const _ of provider.stream({
				model: "claude-sonnet-4.6",
				messages: [{ role: "user", content: "hi" }],
			})) {
				/* drain */
			}
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeDefined();
		expect((caught as Error).name).toBe("TimeoutError");
		expect((caught as Error).message).toContain("timed out after 4 attempt");
	});

	test("logs retry attempts to logger (Anthropic)", async () => {
		let attempt = 0;
		const logged: string[] = [];

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("copilot_internal/v2/token")) {
				return new Response(
					JSON.stringify({
						token: "tid=fresh;exp=9999;proxy-ep=proxy.individual.githubcopilot.com",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			attempt++;
			if (attempt <= 1) {
				const signal = init?.signal;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						if (signal) {
							signal.addEventListener("abort", () =>
								controller.error(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
							);
						}
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const fakeLogger = {
			level: "debug" as const,
			logDir: "",
			debug: () => {},
			info: () => {},
			warn: (system: string, msg: string) => {
				logged.push(`${system}: ${msg}`);
			},
			error: () => {},
			withScope: () => fakeLogger,
		};

		const provider = createCopilotProvider(makeAuth(), configDir, fakeLogger, {
			backoffBaseMs: 10,
			bodyTimeoutMs: 50,
		});
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const retryLogs = logged.filter((l) => l.startsWith("RETRY:"));
		expect(retryLogs.length).toBeGreaterThanOrEqual(1);
		expect(retryLogs[0]).toContain("Anthropic stream attempt 1/4 failed");
		expect(retryLogs[0]).toContain("timeout");
	});
});

// ── Corrupt token detection ───────────────────────────────────────────────

describe("Corrupt token detection", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-corrupt-"));
	});

	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("warns when gho_ refresh token is suspiciously short", () => {
		const logs: string[] = [];
		const logger = {
			level: "debug" as const,
			logDir: "",
			debug: (_s: string, m: string) => logs.push(m),
			info: (_s: string, m: string) => logs.push(m),
			warn: (_s: string, m: string) => logs.push(m),
			error: (_s: string, m: string) => logs.push(m),
		};

		createCopilotProvider(
			{ refresh: "gho_short", access: "tid=x;proxy-ep=proxy.individual.githubcopilot.com", expires: Date.now() + 3_600_000 },
			configDir,
			logger,
		);

		expect(logs.some((l) => l.includes("corrupt") && l.includes("gho_"))).toBe(true);
	});

	test("does not warn when gho_ refresh token has normal length", () => {
		const logs: string[] = [];
		const logger = {
			level: "debug" as const,
			logDir: "",
			debug: (_s: string, m: string) => logs.push(m),
			info: (_s: string, m: string) => logs.push(m),
			warn: (_s: string, m: string) => logs.push(m),
			error: (_s: string, m: string) => logs.push(m),
		};

		createCopilotProvider(
			{
				refresh: "gho_abcdefghijklmnopqrstuvwxyz1234567890ab",
				access: "tid=x;proxy-ep=proxy.individual.githubcopilot.com",
				expires: Date.now() + 3_600_000,
			},
			configDir,
			logger,
		);

		expect(logs.some((l) => l.includes("corrupt"))).toBe(false);
	});
});

// ── Anthropic routing for Claude models ───────────────────────────────────

function anthropicSseStream(events: { event: string; data: Record<string, unknown> }[]): ReadableStream<Uint8Array> {
	const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function anthropicTextResponse(text: string, inputTokens = 10): ReadableStream<Uint8Array> {
	return anthropicSseStream([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-sonnet-4.6",
					usage: { input_tokens: inputTokens, output_tokens: 0 },
				},
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

describe("isCopilotClaude", () => {
	test("matches claude-sonnet-4.6", () => {
		expect(isCopilotClaude("claude-sonnet-4.6")).toBe(true);
	});

	test("matches claude-haiku-4.5", () => {
		expect(isCopilotClaude("claude-haiku-4.5")).toBe(true);
	});

	test("matches claude-opus-4.6", () => {
		expect(isCopilotClaude("claude-opus-4.6")).toBe(true);
	});

	test("matches claude-sonnet-4", () => {
		expect(isCopilotClaude("claude-sonnet-4")).toBe(true);
	});

	test("matches claude-sonnet-4-20250514", () => {
		expect(isCopilotClaude("claude-sonnet-4-20250514")).toBe(true);
	});

	test("does not match gpt-4o", () => {
		expect(isCopilotClaude("gpt-4o")).toBe(false);
	});

	test("does not match gpt-5-mini", () => {
		expect(isCopilotClaude("gpt-5-mini")).toBe(false);
	});

	test("does not match claude-3.5-sonnet (old generation)", () => {
		expect(isCopilotClaude("claude-3.5-sonnet")).toBe(false);
	});
});

describe("Anthropic routing for Claude models", () => {
	const originalFetch = globalThis.fetch;
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-anthropic-"));
		const modelsConfig = [
			{
				id: "claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				contextWindow: 200000,
				maxOutput: 16384,
				premiumRequestMultiplier: 1,
				enabled: true,
			},
			{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64000, maxOutput: 4096, premiumRequestMultiplier: 0, enabled: true },
		];
		fs.writeFileSync(path.join(configDir, "copilot-models.json"), JSON.stringify(modelsConfig));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	test("routes claude-sonnet-4.6 to /v1/messages endpoint", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			capturedUrl = url;
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			} else if (input instanceof Request) {
				capturedBody = await input.clone().json();
			}
			return new Response(anthropicTextResponse("Hello from Claude"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hello" }],
		})) {
			events.push(e);
		}

		// Should hit /v1/messages, NOT chat/completions
		expect(capturedUrl).toContain("/v1/messages");
		expect(capturedUrl).not.toContain("chat/completions");

		// Body should be in Anthropic format
		expect(capturedBody.model).toBe("claude-sonnet-4.6");
		expect(capturedBody.max_tokens).toBeDefined();
		expect(capturedBody.stream).toBe(true);
		// Anthropic format: no "choices", no "messages" wrapping in OpenAI style
		expect(capturedBody.messages).toBeDefined();

		// Should yield text events
		expect(events.some((e) => e.type === "text" && e.text === "Hello from Claude")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
	});

	test("routes gpt-4o through existing chat/completions path", async () => {
		let capturedUrl = "";

		globalThis.fetch = mock(async (input: string | URL | Request, _init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			capturedUrl = url;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hello" }],
		})) {
			events.push(e);
		}

		// Should hit chat/completions, NOT /v1/messages
		expect(capturedUrl).toContain("chat/completions");
		expect(capturedUrl).not.toContain("/v1/messages");
	});

	test("includes Copilot static headers on Anthropic requests", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.headers instanceof Headers) {
				capturedHeaders = Object.fromEntries(init.headers.entries());
			} else if (init?.headers) {
				capturedHeaders = { ...(init.headers as Record<string, string>) };
			} else if (input instanceof Request) {
				capturedHeaders = Object.fromEntries(input.headers.entries());
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		// Copilot standard headers (Anthropic SDK lowercases header names)
		expect(capturedHeaders["user-agent"]).toMatch(/^GitHubCopilotChat\//);
		expect(capturedHeaders["editor-version"]).toBeDefined();
		expect(capturedHeaders["copilot-integration-id"]).toBeDefined();
		// Custom routing headers
		expect(capturedHeaders["x-initiator"]).toBe("user");
		expect(capturedHeaders["openai-intent"]).toBe("conversation-edits");
	});

	test("does not include fine-grained-tool-streaming beta header", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.headers instanceof Headers) {
				capturedHeaders = Object.fromEntries(init.headers.entries());
			} else if (init?.headers) {
				capturedHeaders = { ...(init.headers as Record<string, string>) };
			} else if (input instanceof Request) {
				capturedHeaders = Object.fromEntries(input.headers.entries());
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const betaHeader = capturedHeaders["anthropic-beta"] || "";
		expect(betaHeader).not.toContain("fine-grained-tool-streaming");
	});

	test("yields usage event from Anthropic stream", async () => {
		globalThis.fetch = mock(async (_input: string | URL | Request) => {
			return new Response(anthropicTextResponse("Hello", 42), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		const events: StreamEvent[] = [];
		for await (const e of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(e);
		}

		const usage = events.find((e) => e.type === "usage");
		expect(usage).toBeDefined();
		if (usage?.type === "usage") {
			expect(usage.tokenCount).toBe(42);
			expect(usage.tokenLimit).toBe(200000);
		}
	});

	test("uses max_tokens from model config", async () => {
		let capturedBody: Record<string, unknown>;

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			} else if (input instanceof Request) {
				capturedBody = await input.clone().json();
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(capturedBody.max_tokens).toBe(16384);
	});

	test("converts tools to Anthropic format", async () => {
		let capturedBody: Record<string, unknown>;

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			} else if (input instanceof Request) {
				capturedBody = await input.clone().json();
			}
			return new Response(anthropicTextResponse("ok"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		const tools = [
			{
				type: "function" as const,
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		];
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
			tools,
		})) {
			/* drain */
		}

		// Anthropic format: tools have name, description, input_schema (not function wrapper)
		expect(capturedBody.tools).toBeDefined();
		expect(capturedBody.tools[0].name).toBe("read_file");
		expect(capturedBody.tools[0].input_schema).toBeDefined();
		expect(capturedBody.tools[0].function).toBeUndefined();
	});

	test("accumulates turn metrics for Anthropic path", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(anthropicTextResponse("Hello", 500), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth("test-token"), configDir);
		provider.beginTurn?.(0);
		for await (const _ of provider.stream({
			model: "claude-sonnet-4.6",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const summary = provider.getTurnSummary?.();
		expect(summary).toBeDefined();
		expect(summary).toContain("claude-sonnet-4.6");
		expect(summary).toContain("user: 1");
		expect(summary).toContain("premium: 1.00");
	});
});
