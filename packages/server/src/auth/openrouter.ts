export const OPENROUTER_SMOKE_TEST_MODEL = "nvidia/nemotron-nano-12b-v2-vl:free";

export async function validateOpenRouterKey(
	apiKey: string,
	deps: {
		fetch?: typeof fetch;
	} = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const response = await runFetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: OPENROUTER_SMOKE_TEST_MODEL,
			messages: [{ role: "user", content: "Reply with OK." }],
			max_tokens: 8,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`OpenRouter validation failed: ${response.status} ${body}`);
	}

	await response.json();
}
