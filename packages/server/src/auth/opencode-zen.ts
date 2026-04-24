export const OPENCODE_ZEN_SMOKE_TEST_MODEL = "qwen3.5-plus";

export async function validateOpenCodeZenKey(
	apiKey: string,
	deps: {
		fetch?: typeof fetch;
	} = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const response = await runFetch("https://opencode.ai/zen/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: OPENCODE_ZEN_SMOKE_TEST_MODEL,
			messages: [{ role: "user", content: "Reply with OK." }],
			max_tokens: 8,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`OpenCode Zen validation failed: ${response.status} ${body}`);
	}

	await response.json();
}
