import { afterEach, describe, expect, mock, test } from "bun:test";
import { deriveBaseUrl, enableModels, exchangeToken } from "../src/provider/copilot";
import { AuthError, ProviderError } from "../src/provider/provider";

describe("deriveBaseUrl", () => {
	test("extracts base URL from proxy-ep in token", () => {
		const token = "tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom";
		expect(deriveBaseUrl(token)).toBe("https://api.individual.githubcopilot.com");
	});

	test("returns fallback when proxy-ep is missing", () => {
		expect(deriveBaseUrl("tid=abc;exp=123")).toBe("https://api.individual.githubcopilot.com");
	});

	test("handles proxy-ep at end of token without trailing semicolon", () => {
		const token = "tid=abc;proxy-ep=proxy.example.com";
		expect(deriveBaseUrl(token)).toBe("https://api.example.com");
	});
});

describe("exchangeToken", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("exchanges GitHub token for Copilot session token", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(
				JSON.stringify({
					token: "tid=abc;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: 1700000000,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const result = await exchangeToken("gho_test123");

		expect(capturedUrl).toBe("https://api.github.com/copilot_internal/v2/token");
		expect(capturedHeaders.Authorization).toBe("Bearer gho_test123");
		expect(result.access).toBe("tid=abc;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com");
		expect(result.expires).toBe(1700000000 * 1000 - 5 * 60 * 1000);
		expect(result.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	test("throws AuthError(permanent=true) on 401", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		try {
			await exchangeToken("gho_bad");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AuthError);
			const authErr = err as AuthError;
			expect(authErr.status).toBe(401);
			expect(authErr.permanent).toBe(true);
		}
	});

	test("throws AuthError(permanent=true) on 403", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		try {
			await exchangeToken("gho_bad");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AuthError);
			expect((err as AuthError).permanent).toBe(true);
		}
	});

	test("throws AuthError(permanent=false) on 500", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Server Error", { status: 500 });
		}) as typeof fetch;

		try {
			await exchangeToken("gho_refresh");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AuthError);
			expect((err as AuthError).permanent).toBe(false);
		}
	});

	test("wraps network errors as AuthError(permanent=false)", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("Unable to connect. Is the computer able to access the internet?");
		}) as typeof fetch;

		try {
			await exchangeToken("gho_refresh");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AuthError);
			const authErr = err as AuthError;
			expect(authErr.permanent).toBe(false);
			expect(authErr.body).toContain("Unable to connect");
		}
	});

	test("throws AuthError on invalid response shape", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
		}) as typeof fetch;

		try {
			await exchangeToken("gho_bad");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AuthError);
			expect((err as AuthError).permanent).toBe(false);
		}
	});
});

describe("enableModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("posts to /models/{id}/policy for each model", async () => {
		const urls: string[] = [];
		const bodies: unknown[] = [];

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			urls.push(url.toString());
			bodies.push(JSON.parse(init?.body as string));
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("session-tok", "https://api.individual.githubcopilot.com", ["gpt-4o", "claude-sonnet-4.6"]);

		expect(urls).toContain("https://api.individual.githubcopilot.com/models/gpt-4o/policy");
		expect(urls).toContain("https://api.individual.githubcopilot.com/models/claude-sonnet-4.6/policy");
		expect(bodies[0]).toEqual({ state: "enabled" });
	});

	test("sends session token and correct headers", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("my-session-tok", "https://api.example.com", ["gpt-4o"]);

		expect(capturedHeaders.Authorization).toBe("Bearer my-session-tok");
		expect(capturedHeaders["openai-intent"]).toBe("chat-policy");
		expect(capturedHeaders["x-interaction-type"]).toBe("chat-policy");
	});

	test("does not throw on individual model failure", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		// Should not throw
		await enableModels("tok", "https://api.example.com", ["gpt-4o", "claude-sonnet-4.6"]);
	});

	test("runs all enablements in parallel", async () => {
		const timestamps: number[] = [];

		globalThis.fetch = mock(async () => {
			timestamps.push(Date.now());
			await Bun.sleep(50);
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await enableModels("tok", "https://api.example.com", ["a", "b", "c"]);

		// All should start within ~30ms of each other (parallel, not sequential)
		const spread = Math.max(...timestamps) - Math.min(...timestamps);
		expect(spread).toBeLessThan(30);
	});
});

describe("AuthError", () => {
	test("is an instance of ProviderError", () => {
		const err = new AuthError(401, "Unauthorized", true);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err).toBeInstanceOf(AuthError);
		expect(err).toBeInstanceOf(Error);
	});

	test("has name AuthError", () => {
		const err = new AuthError(401, "Unauthorized", true);
		expect(err.name).toBe("AuthError");
	});

	test("permanent flag distinguishes re-auth from transient", () => {
		const permanent = new AuthError(401, "Unauthorized", true);
		expect(permanent.permanent).toBe(true);

		const transient = new AuthError(500, "Server Error", false);
		expect(transient.permanent).toBe(false);
	});

	test("inherits status and body from ProviderError", () => {
		const err = new AuthError(403, "Forbidden", true);
		expect(err.status).toBe(403);
		expect(err.body).toBe("Forbidden");
		expect(err.message).toContain("403");
	});
});
