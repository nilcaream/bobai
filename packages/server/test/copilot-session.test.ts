import { afterEach, describe, expect, mock, test } from "bun:test";
import { deriveBaseUrl, exchangeToken } from "../src/provider/copilot";

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

	test("merges config headers into exchange request", async () => {
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = { ...(init?.headers as Record<string, string>) };
			return new Response(
				JSON.stringify({
					token: "tid=x;exp=1;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: 1700000000,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		await exchangeToken("gho_test", { "User-Agent": "CustomAgent/1.0" });

		expect(capturedHeaders["User-Agent"]).toBe("CustomAgent/1.0");
	});

	test("throws on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Forbidden", { status: 403 });
		}) as typeof fetch;

		expect(exchangeToken("gho_bad")).rejects.toThrow();
	});

	test("throws on invalid response shape", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
		}) as typeof fetch;

		expect(exchangeToken("gho_bad")).rejects.toThrow();
	});
});
