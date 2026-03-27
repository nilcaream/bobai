import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredAuth } from "../src/auth/store";
import { createCopilotProvider } from "../src/provider/copilot";
import type { StreamEvent } from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

function makeAuth(access = "tok"): StoredAuth {
	return { refresh: "gho_refresh", access, expires: Date.now() + 3_600_000 };
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
		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth("test-token"));
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth("bad-token"));
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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
				{ refresh: "gho_refresh", access: "expired-tok", expires: Date.now() - 1000 },
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
			expect(fetchCalls[0].headers.Authorization).toBe("Bearer gho_refresh");
			expect(fetchCalls[1].url).toContain("chat/completions");
			expect(fetchCalls[1].headers.Authorization).toContain("tid=new");

			// Should persist the refreshed auth
			const saved = JSON.parse(fs.readFileSync(path.join(configDir, "auth.json"), "utf8"));
			expect(saved.refresh).toBe("gho_refresh");
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

		const provider = createCopilotProvider(makeAuth("valid-tok"));

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
			refresh: "gho_r",
			access: "tid=x;proxy-ep=proxy.custom.example.com",
			expires: Date.now() + 3_600_000,
		};
		const provider = createCopilotProvider(auth);

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

		provider.beginTurn!(0);
		await drain(provider);

		const summary = provider.getTurnSummary!();
		expect(summary).toBeDefined();
		// Should show "context: 3500" (absolute, no sign)
		expect(summary).toContain("context: 3500");
		expect(summary).not.toMatch(/context: [+-]3500/);
	});

	test("subagent session (beginTurn()) with no argument shows absolute context", async () => {
		mockFetchWithUsage(2000, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn!();
		await drain(provider);

		const summary = provider.getTurnSummary!();
		expect(summary).toBeDefined();
		// No sessionPromptTokens → baselineTokens is 0 → absolute display
		expect(summary).toContain("context: 2000");
	});

	test("parent session (beginTurn(5000)) shows context delta with sign", async () => {
		mockFetchWithUsage(5800, 300);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn!(5000);
		await drain(provider);

		const summary = provider.getTurnSummary!();
		expect(summary).toBeDefined();
		// Delta: 5800 - 5000 = +800
		expect(summary).toContain("context: +800");
	});

	test("parent session shows negative delta when context shrinks", async () => {
		mockFetchWithUsage(4200, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn!(5000);
		await drain(provider);

		const summary = provider.getTurnSummary!();
		expect(summary).toBeDefined();
		// Delta: 4200 - 5000 = -800
		expect(summary).toContain("context: -800");
	});

	test("parent session shows zero delta without sign", async () => {
		mockFetchWithUsage(5000, 100);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn!(5000);
		await drain(provider);

		const summary = provider.getTurnSummary!();
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
		provider.beginTurn!(30000);
		await drain(provider);
		expect(provider.getTurnPromptTokens!()).toBe(41965);

		// Now a subagent starts — save parent, begin subagent turn
		const saved = provider.saveTurnState!();
		provider.beginTurn!(0);

		// Subagent makes a call
		mockFetchWithUsage(3500, 200);
		await drain(provider);

		const subSummary = provider.getTurnSummary!();
		// Subagent should show absolute "context: 3500", NOT "context: -38465"
		expect(subSummary).toContain("context: 3500");
		expect(subSummary).not.toMatch(/context: [+-]/);

		// Restore parent state
		provider.restoreTurnState!(saved);
		const parentSummary = provider.getTurnSummary!();
		// Parent should still show its own delta: 41965 - 30000 = +11965
		expect(parentSummary).toContain("context: +11965");
	});

	test("getTurnSummary returns undefined when no turn has started", () => {
		const provider = createCopilotProvider(makeAuth(), configDir);
		expect(provider.getTurnSummary!()).toBeUndefined();
	});

	test("getTurnSummary includes all expected fields", async () => {
		mockFetchWithUsage(1000, 50);
		const provider = createCopilotProvider(makeAuth(), configDir);

		provider.beginTurn!(0);
		await drain(provider);

		const summary = provider.getTurnSummary!();
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
			{ refresh: "gho_refresh", access: "expired-tok", expires: Date.now() - 1000 },
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
			{ refresh: "gho_refresh", access: "expired-tok", expires: Date.now() - 1000 },
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

// ── Retry logic ───────────────────────────────────────────────────────────

describe("Retry logic", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
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

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());
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

	test("does not retry on 4xx other than 429", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async () => {
			attempt++;
			return new Response("Bad Request", { status: 400 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth());

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
		expect((caught as ProviderError).status).toBe(400);
	});

	test("retries on timeout (fetch throws) and succeeds", async () => {
		let attempt = 0;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			attempt++;
			if (attempt <= 1) {
				// Simulate a timeout by aborting via the signal
				const error = new DOMException("The operation timed out", "TimeoutError");
				throw error;
			}
			return new Response(sseStream([chatChunk("recovered"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth());
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

		const provider = createCopilotProvider(makeAuth());

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

		const provider = createCopilotProvider(makeAuth());

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
		const provider = createCopilotProvider({ refresh: "gho_refresh", access: "tid=original", expires: Date.now() + 100 });

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

		const provider = createCopilotProvider(makeAuth());
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

	test("exponential backoff increases delay between retries", async () => {
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

		const provider = createCopilotProvider(makeAuth());
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		expect(attempt).toBe(4);
		// Verify backoff is increasing: gap2 > gap1, gap3 > gap2
		// Backoff is 2s, 4s, 8s — but we allow some tolerance
		const gap1 = timestamps[1] - timestamps[0]; // ~2000ms
		const gap2 = timestamps[2] - timestamps[1]; // ~4000ms
		const gap3 = timestamps[3] - timestamps[2]; // ~8000ms

		expect(gap1).toBeGreaterThan(1500); // 2s with tolerance
		expect(gap2).toBeGreaterThan(3500); // 4s with tolerance
		expect(gap3).toBeGreaterThan(7000); // 8s with tolerance
		expect(gap2).toBeGreaterThan(gap1);
		expect(gap3).toBeGreaterThan(gap2);
	});
});
