export const OPENCODE_GO_SMOKE_TEST_MODEL = "qwen3.5-plus";

export async function validateOpenCodeGoKey(
	apiKey: string,
	deps: {
		fetch?: typeof fetch;
	} = {},
): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const response = await runFetch("https://opencode.ai/zen/go/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: OPENCODE_GO_SMOKE_TEST_MODEL,
			messages: [{ role: "user", content: "Reply with OK." }],
			max_tokens: 8,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`OpenCode Go validation failed: ${response.status} ${body}`);
	}

	await response.json();
}
