import pkg from "../../package.json";
import type { Message, Provider, ProviderOptions, StreamEvent } from "./provider";
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

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
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
					...(options.tools?.length ? { tools: options.tools } : {}),
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
					choices?: {
						delta?: {
							content?: string;
							tool_calls?: {
								index: number;
								id?: string;
								type?: string;
								function?: { name?: string; arguments?: string };
							}[];
						};
						finish_reason?: string | null;
					}[];
				};

				const choice = data.choices?.[0];

				if (choice?.finish_reason) {
					const reason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
					yield { type: "finish" as const, reason } as StreamEvent;
					return;
				}

				const content = choice?.delta?.content;
				if (content) {
					yield { type: "text" as const, text: content };
				}

				const toolCalls = choice?.delta?.tool_calls;
				if (toolCalls) {
					for (const tc of toolCalls) {
						if (tc.id && tc.function?.name) {
							yield { type: "tool_call_start" as const, index: tc.index, id: tc.id, name: tc.function.name };
						}
						if (tc.function?.arguments) {
							yield { type: "tool_call_delta" as const, index: tc.index, arguments: tc.function.arguments };
						}
					}
				}
			}

			yield { type: "finish" as const, reason: "stop" as const };
		},
	};
}
