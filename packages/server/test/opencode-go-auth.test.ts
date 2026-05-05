import { describe, expect, test } from "bun:test";
import { OPENCODE_GO_SMOKE_TEST_MODEL, validateOpenCodeGoKey } from "../src/auth/opencode-go";
import { getDefaultModelForProvider } from "../src/provider/providers";

describe("validateOpenCodeGoKey", () => {
	test("sends a smoke test request to the provider default chat-completions model", async () => {
		let seenUrl: string | undefined;
		let seenRequest: RequestInit | undefined;

		await validateOpenCodeGoKey("key-123", {
			fetch: async (url, init) => {
				seenUrl = String(url);
				seenRequest = init;
				return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
			},
		});

		expect(seenUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
		expect(seenRequest?.method).toBe("POST");
		expect((seenRequest?.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
		const body = JSON.parse(String(seenRequest?.body));
		expect(OPENCODE_GO_SMOKE_TEST_MODEL).toBe(getDefaultModelForProvider("opencode-go"));
		expect(body.model).toBe(getDefaultModelForProvider("opencode-go"));
		expect(body.max_tokens).toBe(8);
	});

	test("surfaces quota errors without dumping the raw JSON body", async () => {
		await expect(
			validateOpenCodeGoKey("quota-key", {
				fetch: async () =>
					new Response(
						JSON.stringify({
							error: {
								message:
									"Error from provider (Alibaba): You exceeded your current quota, please check your plan and billing details.",
								type: "insufficient_quota",
								code: "insufficient_quota",
							},
						}),
						{ status: 429 },
					),
			}),
		).rejects.toThrow(
			`OpenCode Go validation request hit a quota or rate limit for model ${getDefaultModelForProvider("opencode-go")} (429 insufficient_quota): Error from provider (Alibaba): You exceeded your current quota, please check your plan and billing details.`,
		);
	});

	test("throws when OpenCode Go returns an auth error", async () => {
		await expect(
			validateOpenCodeGoKey("bad-key", {
				fetch: async () => new Response("Unauthorized", { status: 401 }),
			}),
		).rejects.toThrow("OpenCode Go API key was rejected (401): Unauthorized");
	});
});
