export const AMAZON_BEDROCK_DEFAULT_REGION = "us-east-1";

export async function validateAmazonBedrockKey(
	apiKey: string,
	region: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	// Use the /v1/models endpoint: lightweight GET, no model ID required,
	// confirms the bearer token is accepted by the mantle endpoint.
	const url = `https://bedrock-mantle.${region}.api.aws/v1/models`;

	const response = await runFetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`Amazon Bedrock validation failed: ${response.status} ${body}`);
	}
}
