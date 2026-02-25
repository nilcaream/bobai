import type { Provider, ProviderOptions } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_API = "https://api.githubcopilot.com/chat/completions";

export function createCopilotProvider(token: string): Provider {
	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<string> {
			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Openai-Intent": "conversation-edits",
				},
				body: JSON.stringify({
					model: options.model,
					messages: options.messages,
					stream: true,
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				throw new ProviderError(response.status, await response.text());
			}

			if (!response.body) {
				return;
			}

			for await (const event of parseSSE(response.body)) {
				const data = event as {
					choices?: { delta?: { content?: string } }[];
				};
				const content = data.choices?.[0]?.delta?.content;
				if (content) yield content;
			}
		},
	};
}
