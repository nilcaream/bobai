import { describe, expect, test } from "bun:test";
import { DEEPSEEK_SMOKE_TEST_MODEL, validateDeepSeekKey } from "../src/auth/deepseek";

describe("validateDeepSeekKey", () => {
	test("sends a smoke test request to the fixed model", async () => {
		let seenUrl: string | undefined;
		let seenRequest: RequestInit | undefined;

		await validateDeepSeekKey("key-123", {
			fetch: async (url, init) => {
				seenUrl = String(url);
				seenRequest = init;
				return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
			},
		});

		expect(seenUrl).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(seenRequest?.method).toBe("POST");
		expect((seenRequest?.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
		const body = JSON.parse(String(seenRequest?.body));
		expect(body.model).toBe(DEEPSEEK_SMOKE_TEST_MODEL);
		expect(body.max_tokens).toBe(8);
	});

	test("throws when DeepSeek returns an error status", async () => {
		await expect(
			validateDeepSeekKey("bad-key", {
				fetch: async () => new Response("Unauthorized", { status: 401 }),
			}),
		).rejects.toThrow(/401|Unauthorized/);
	});
});
