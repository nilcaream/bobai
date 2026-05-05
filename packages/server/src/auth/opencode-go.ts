import { getDefaultModelForProvider } from "../provider/providers";

export const OPENCODE_GO_SMOKE_TEST_MODEL = getDefaultModelForProvider("opencode-go");

function formatOpenCodeGoValidationError(status: number, rawBody: string, modelId: string): string {
	const trimmedBody = rawBody.trim();
	let message = trimmedBody || "Request failed";
	let code = "";

	if (trimmedBody.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmedBody) as {
				error?: {
					message?: string;
					code?: string;
					type?: string;
				};
			};
			message = parsed.error?.message?.trim() || message;
			code = parsed.error?.code?.trim() || parsed.error?.type?.trim() || "";
		} catch {
			// Keep the original body if parsing fails.
		}
	}

	const codeSuffix = code ? ` ${code}` : "";
	if (status === 401 || status === 403) {
		return `OpenCode Go API key was rejected (${status}): ${message}`;
	}
	if (status === 429) {
		return `OpenCode Go validation request hit a quota or rate limit for model ${modelId} (${status}${codeSuffix}): ${message}`;
	}
	if (status >= 400 && status < 500) {
		return `OpenCode Go validation request failed for model ${modelId} (${status}${codeSuffix}): ${message}`;
	}
	return `OpenCode Go validation failed for model ${modelId} (${status}${codeSuffix}): ${message}`;
}

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
		throw new Error(formatOpenCodeGoValidationError(response.status, body, OPENCODE_GO_SMOKE_TEST_MODEL));
	}

	await response.json();
}
