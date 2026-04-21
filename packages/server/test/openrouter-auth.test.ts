import { describe, expect, test } from "bun:test";
import { OPENROUTER_SMOKE_TEST_MODEL, validateOpenRouterKey } from "../src/auth/openrouter";

describe("validateOpenRouterKey", () => {
	test("sends a smoke test request to the fixed model", async () => {
		let seenUrl: string | undefined;
		let seenRequest: RequestInit | undefined;

		await validateOpenRouterKey("key-123", {
			fetch: async (url, init) => {
				seenUrl = String(url);
				seenRequest = init;
				return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
			},
		});

		expect(seenUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(seenRequest?.method).toBe("POST");
		expect((seenRequest?.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
		const body = JSON.parse(String(seenRequest?.body));
		expect(body.model).toBe(OPENROUTER_SMOKE_TEST_MODEL);
		expect(body.max_tokens).toBe(8);
	});

	test("throws when OpenRouter returns an error status", async () => {
		await expect(
			validateOpenRouterKey("bad-key", {
				fetch: async () => new Response("Unauthorized", { status: 401 }),
			}),
		).rejects.toThrow(/401|Unauthorized/);
	});
});
