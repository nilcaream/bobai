import { describe, expect, mock, test } from "bun:test";
import { validateTavilyKey } from "../../src/auth/tavily";

describe("validateTavilyKey", () => {
	test("accepts a valid key and calls Tavily search endpoint", async () => {
		const mockFetch = mock().mockResolvedValue({ ok: true, status: 200 });
		await validateTavilyKey("tvly-test-key", { fetch: mockFetch as unknown as typeof fetch });
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.tavily.com/search");
		expect(init.method).toBe("POST");
		expect(init.headers).toHaveProperty("Authorization", "Bearer tvly-test-key");
		const body = JSON.parse(init.body as string);
		expect(body.query).toBe("test");
		expect(body.max_results).toBe(1);
	});

	test("throws on non-ok response with status code", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: async () => "Invalid API key",
		});
		await expect(validateTavilyKey("bad-key", { fetch: mockFetch as unknown as typeof fetch })).rejects.toThrow(/401/);
	});

	test("throws with status text when body unavailable", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			text: async () => {
				throw new Error("cannot read body");
			},
		});
		await expect(validateTavilyKey("key", { fetch: mockFetch as unknown as typeof fetch })).rejects.toThrow(
			/429.*Too Many Requests/,
		);
	});
});
