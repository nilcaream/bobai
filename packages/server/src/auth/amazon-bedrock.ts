export const AMAZON_BEDROCK_DEFAULT_REGION = "us-east-1";

/** Shape returned by GET /foundation-models on the Bedrock service API. */
export interface BedrockFoundationModelSummary {
	modelId: string;
	modelName: string;
	providerName: string;
	inputModalities: string[];
	outputModalities: string[];
	responseStreamingSupported?: boolean;
	inferenceTypesSupported?: string[];
	modelLifecycle?: { status: string };
}

/**
 * Fetches the list of foundation models available in the given region.
 * Throws with a descriptive message on HTTP error (used for key validation).
 */
export async function fetchBedrockFoundationModels(
	apiKey: string,
	region: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<BedrockFoundationModelSummary[]> {
	const runFetch = deps.fetch ?? fetch;
	const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;

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

	const data = (await response.json()) as { modelSummaries?: BedrockFoundationModelSummary[] };
	return data.modelSummaries ?? [];
}

/**
 * Validates an Amazon Bedrock bearer token by attempting to list foundation models.
 * Throws if the token is invalid or the request fails.
 */
export async function validateAmazonBedrockKey(
	apiKey: string,
	region: string,
	deps: { fetch?: typeof fetch } = {},
): Promise<void> {
	await fetchBedrockFoundationModels(apiKey, region, deps);
}
