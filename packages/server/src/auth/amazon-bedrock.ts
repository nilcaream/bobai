export const AMAZON_BEDROCK_SMOKE_TEST_MODEL = "anthropic.claude-haiku-4-5";
export const AMAZON_BEDROCK_DEFAULT_REGION = "us-east-1";

export async function validateAmazonBedrockKey(
	apiKey: string,
	region: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const url = `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`;

	const response = await runFetch(url, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: AMAZON_BEDROCK_SMOKE_TEST_MODEL,
			max_tokens: 8,
			stream: true,
			messages: [{ role: "user", content: "Reply with OK." }],
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`Amazon Bedrock validation failed: ${response.status} ${body}`);
	}
}
