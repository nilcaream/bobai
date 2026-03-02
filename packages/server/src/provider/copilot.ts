import fs from "node:fs";
import path from "node:path";
import pkg from "../../package.json";
import { fetchCatalog } from "../models-catalog";
import { buildModelConfigs } from "./copilot-models";
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

export interface RefreshResult {
	total: number;
	enabled: number;
	configPath: string;
}

export async function refreshModels(token: string, configDir: string): Promise<RefreshResult> {
	console.log("Fetching model catalog from models.dev...");
	const catalog = await fetchCatalog("github-copilot");
	const configs = buildModelConfigs(catalog);

	for (const config of configs) {
		process.stdout.write(`Checking ${config.id}... `);
		try {
			const response = await fetch(COPILOT_API, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
					"Openai-Intent": "conversation-edits",
					Authorization: `Bearer ${token}`,
					"x-initiator": "agent",
				},
				body: JSON.stringify({
					model: config.id,
					messages: [{ role: "user", content: "Ping. Respond pong." }],
					stream: false,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (response.ok) {
				config.enabled = true;
				console.log("ok");
			} else {
				console.log(`failed (${response.status})`);
			}
		} catch (err) {
			console.log(`failed (${err instanceof Error ? err.message : "unknown error"})`);
		}
	}

	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, "copilot-models.json");
	fs.writeFileSync(configPath, JSON.stringify(configs, null, "\t"));

	const enabled = configs.filter((c) => c.enabled).length;
	console.log(`Wrote ${configs.length} models (${enabled} enabled) to ${configPath}`);

	return { total: configs.length, enabled, configPath };
}
