export async function validateTavilyKey(apiKey: string, deps: { fetch?: typeof fetch } = {}): Promise<void> {
	const runFetch = deps.fetch ?? fetch;
	const response = await runFetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query: "test", max_results: 1 }),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`Tavily validation failed: ${response.status} ${body}`);
	}
}
