import pkg from "../../package.json";
import type { Message, Provider, ProviderOptions } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_API = "https://api.githubcopilot.com/chat/completions";
const USER_AGENT = `bobai/${pkg.version}`;

function resolveInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last?.role === "user" ? "user" : "agent";
}

export function createCopilotProvider(token: string, configHeaders: Record<string, string> = {}): Provider {
	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<string> {
			const defaults: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"Openai-Intent": "conversation-edits",
			};

			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					...defaults,
					...configHeaders,
					Authorization: `Bearer ${token}`,
					"x-initiator": resolveInitiator(options.messages),
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
