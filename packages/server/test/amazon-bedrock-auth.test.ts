import { describe, expect, test } from "bun:test";
import { AMAZON_BEDROCK_DEFAULT_REGION, validateAmazonBedrockKey } from "../src/auth/amazon-bedrock";

describe("validateAmazonBedrockKey", () => {
	test("sends GET /foundation-models to the Bedrock service endpoint with Bearer auth", async () => {
		let seenUrl: string | undefined;
		let seenRequest: RequestInit | undefined;

		await validateAmazonBedrockKey("bk-token", "us-east-1", {
			fetch: async (url, init) => {
				seenUrl = String(url);
				seenRequest = init;
				return new Response(JSON.stringify({ modelSummaries: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});

		expect(seenUrl).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models");
		expect(seenRequest?.method).toBe("GET");
		expect((seenRequest?.headers as Record<string, string>).Authorization).toBe("Bearer bk-token");
	});

	test("uses provided region in the URL", async () => {
		let seenUrl: string | undefined;
		await validateAmazonBedrockKey("bk-token", "eu-central-1", {
			fetch: async (url) => {
				seenUrl = String(url);
				return new Response(JSON.stringify({ modelSummaries: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		expect(seenUrl).toContain("eu-central-1");
	});

	test("throws when Bedrock returns a non-OK status", async () => {
		await expect(
			validateAmazonBedrockKey("bad", AMAZON_BEDROCK_DEFAULT_REGION, {
				fetch: async () => new Response("Forbidden", { status: 403 }),
			}),
		).rejects.toThrow(/403|Forbidden/);
	});
});
