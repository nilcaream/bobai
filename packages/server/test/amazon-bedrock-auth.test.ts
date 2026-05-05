import { describe, expect, test } from "bun:test";
import { AMAZON_BEDROCK_DEFAULT_REGION, AMAZON_BEDROCK_SMOKE_TEST_MODEL, validateAmazonBedrockKey } from "../src/auth/amazon-bedrock";

describe("validateAmazonBedrockKey", () => {
  test("sends smoke test to the Anthropic Messages API sub-path on mantle", async () => {
    let seenUrl: string | undefined;
    let seenRequest: RequestInit | undefined;

    await validateAmazonBedrockKey("bk-token", "us-east-1", {
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenRequest = init;
        return new Response(
          "data: {}\n\ndata: [DONE]\n\n",
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    expect(seenUrl).toBe(`https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages`);
    expect((seenRequest?.headers as Record<string, string>)["x-api-key"]).toBe("bk-token");
    const body = JSON.parse(String(seenRequest?.body));
    expect(body.model).toBe(AMAZON_BEDROCK_SMOKE_TEST_MODEL);
    expect(body.stream).toBe(true);
  });

  test("uses provided region in the URL", async () => {
    let seenUrl: string | undefined;
    await validateAmazonBedrockKey("bk-token", "eu-central-1", {
      fetch: async (url) => {
        seenUrl = String(url);
        return new Response("data: {}\n\ndata: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
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
