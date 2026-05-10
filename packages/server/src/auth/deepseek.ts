export const DEEPSEEK_SMOKE_TEST_MODEL = "deepseek-v4-flash";

export async function validateDeepSeekKey(
	apiKey: string,
	deps: {
		fetch?: typeof fetch;
	} = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const response = await runFetch("https://api.deepseek.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: DEEPSEEK_SMOKE_TEST_MODEL,
			messages: [{ role: "user", content: "Reply with OK." }],
			max_tokens: 8,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`DeepSeek validation failed: ${response.status} ${body}`);
	}

	await response.json();
}
