import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pkg from "../../package.json";
import { type StoredAuth, saveAuth } from "../auth/store";
import { fetchCatalog } from "../models-catalog";
import type { ModelConfig } from "./copilot-models";
import { buildModelConfigs } from "./copilot-models";
import type { Message, Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const USER_AGENT = `bobai/${pkg.version}`;

export function deriveBaseUrl(token: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return DEFAULT_BASE_URL;
	const host = match[1].replace(/^proxy\./, "api.");
	return `https://${host}`;
}

export async function exchangeToken(
	refreshToken: string,
	configHeaders?: Record<string, string>,
): Promise<{ access: string; expires: number; baseUrl: string }> {
	const defaults: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Accept: "application/json",
	};

	const response = await fetch(COPILOT_TOKEN_URL, {
		method: "GET",
		headers: {
			...defaults,
			...configHeaders,
			Authorization: `Bearer ${refreshToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { token?: string; expires_at?: number };

	if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
		throw new Error("Invalid token exchange response: missing token or expires_at");
	}

	return {
		access: data.token,
		expires: data.expires_at * 1000 - 5 * 60 * 1000,
		baseUrl: deriveBaseUrl(data.token),
	};
}

function resolveInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last?.role === "user" ? "user" : "agent";
}

export function createCopilotProvider(
	auth: StoredAuth,
	configHeaders: Record<string, string> = {},
	configDir?: string,
): Provider {
	const resolvedConfigDir = configDir ?? path.join(os.homedir(), ".config", "bobai");
	let modelsConfig: ModelConfig[] | null = null;

	// Mutable session state
	let sessionToken = auth.access;
	let sessionExpires = auth.expires;
	let baseUrl = deriveBaseUrl(auth.access);
	const refreshToken = auth.refresh;

	async function ensureValidSession(): Promise<void> {
		if (Date.now() < sessionExpires) return;
		const result = await exchangeToken(refreshToken, configHeaders);
		sessionToken = result.access;
		sessionExpires = result.expires;
		baseUrl = result.baseUrl;
		saveAuth(resolvedConfigDir, { refresh: refreshToken, access: sessionToken, expires: sessionExpires });
	}

	function loadModelsConfig(): ModelConfig[] {
		if (modelsConfig !== null) return modelsConfig;
		try {
			const raw = fs.readFileSync(path.join(resolvedConfigDir, "copilot-models.json"), "utf8");
			modelsConfig = JSON.parse(raw) as ModelConfig[];
		} catch {
			modelsConfig = [];
		}
		return modelsConfig;
	}

	return {
		id: "github-copilot",

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			await ensureValidSession();

			const defaults: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"Openai-Intent": "conversation-edits",
			};

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					...defaults,
					...configHeaders,
					Authorization: `Bearer ${sessionToken}`,
					"x-initiator": options.initiator ?? resolveInitiator(options.messages),
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
					usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
				};

				const choice = data.choices?.[0];

				if (choice?.finish_reason) {
					const totalTokens = data.usage?.total_tokens ?? 0;
					const models = loadModelsConfig();
					const modelConfig = models.find((m) => m.id === options.model);
					const contextWindow = modelConfig?.contextWindow ?? 0;

					let display: string;
					if (contextWindow > 0) {
						const percent = Math.round((totalTokens / contextWindow) * 100);
						display = `${totalTokens} / ${contextWindow} | ${percent}%`;
					} else {
						display = `${totalTokens} tokens`;
					}

					yield { type: "usage" as const, tokenCount: totalTokens, tokenLimit: contextWindow, display };

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

export async function enableModels(
	sessionToken: string,
	baseUrl: string,
	modelIds: string[],
	configHeaders?: Record<string, string>,
): Promise<void> {
	const defaults: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
		"openai-intent": "chat-policy",
		"x-interaction-type": "chat-policy",
	};

	await Promise.all(
		modelIds.map(async (id) => {
			try {
				const response = await fetch(`${baseUrl}/models/${id}/policy`, {
					method: "POST",
					headers: {
						...defaults,
						...configHeaders,
						Authorization: `Bearer ${sessionToken}`,
					},
					body: JSON.stringify({ state: "enabled" }),
				});
				if (response.ok) {
					console.log(`  ${id}: enabled`);
				} else {
					console.log(`  ${id}: failed (${response.status})`);
				}
			} catch (err) {
				console.log(`  ${id}: failed (${err instanceof Error ? err.message : String(err)})`);
			}
		}),
	);
}

export interface RefreshResult {
	total: number;
	enabled: number;
	configPath: string;
}

export async function refreshModels(
	sessionToken: string,
	baseUrl: string,
	configDir: string,
	configHeaders: Record<string, string> = {},
): Promise<RefreshResult> {
	console.log("Fetching model catalog from models.dev...");
	const catalog = await fetchCatalog("github-copilot");
	const configs = buildModelConfigs(catalog);

	console.log("Enabling models...");
	await enableModels(
		sessionToken,
		baseUrl,
		configs.map((c) => c.id),
		configHeaders,
	);
	console.log("");

	for (const config of configs) {
		process.stdout.write(`Checking ${config.id}... `);
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
					"Openai-Intent": "conversation-edits",
					...configHeaders,
					Authorization: `Bearer ${sessionToken}`,
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
