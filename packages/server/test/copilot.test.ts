import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
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

	afterEach(() => {
		globalThis.fetch = originalFetch;
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
		expect(headers["User-Agent"]).toMatch(/^bobai\//);
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

	test("config headers override default headers", async () => {
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(sseStream([chatChunk("hi"), "[DONE]"]), { status: 200 });
		}) as typeof fetch;

		const provider = createCopilotProvider(makeAuth(), {
			"User-Agent": "CustomAgent/2.0",
			"X-Custom": "value",
		});
		for await (const _ of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			/* drain */
		}

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toBe("CustomAgent/2.0");
		expect(headers["X-Custom"]).toBe("value");
		expect(headers["Openai-Intent"]).toBe("conversation-edits");
	});

	test("uses default headers when no config headers provided", async () => {
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
		expect(headers["User-Agent"]).toMatch(/^bobai\//);
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

		const provider = createCopilotProvider(makeAuth());
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
			{ type: "usage", tokenCount: 0, tokenLimit: 0, display: "0 tokens" },
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

		const provider = createCopilotProvider(makeAuth());
		const events: StreamEvent[] = [];
		for await (const t of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(t);
		}

		expect(events).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "usage", tokenCount: 0, tokenLimit: 0, display: "0 tokens" },
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

			const provider = createCopilotProvider(makeAuth(), {}, configDir);
			const events: StreamEvent[] = [];
			for await (const t of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(t);
			}

			expect(events).toEqual([
				{ type: "text", text: "Hello" },
				{ type: "usage", tokenCount: 932, tokenLimit: 64000, display: "932 / 64000 | 1%" },
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

			const provider = createCopilotProvider(makeAuth(), {}, configDir);
			const events: StreamEvent[] = [];
			for await (const t of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			})) {
				events.push(t);
			}

			expect(events).toEqual([
				{ type: "text", text: "Hi" },
				{ type: "usage", tokenCount: 150, tokenLimit: 0, display: "150 tokens" },
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
				{},
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
