import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type StoredAuth, saveAuth } from "../auth/store";
import { fetchCatalog } from "../models-catalog";
import { buildModelConfigs, formatModelDisplay, loadModelsConfig, PREMIUM_REQUEST_MULTIPLIERS } from "./copilot-models";
import type { Message, Provider, ProviderOptions, StreamEvent } from "./provider";
import { ProviderError } from "./provider";
import { parseSSE } from "./sse";

const COPILOT_CONFIGURATION =
	"eyJjbGllbnRJZCI6Ikl2MS5iNTA3YTA4Yzg3ZWNmZTk4IiwiaGVhZGVycyI6eyJVc2VyLUFnZW50IjoiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wIiwiRWRpdG9yLVZlcnNpb24iOiJ2c2NvZGUvMS4xMDcuMCIsIkVkaXRvci1QbHVnaW4tVmVyc2lvbiI6ImNvcGlsb3QtY2hhdC8wLjM1LjAiLCJDb3BpbG90LUludGVncmF0aW9uLUlkIjoidnNjb2RlLWNoYXQifX0=";

export const copilotConfig = JSON.parse(atob(COPILOT_CONFIGURATION)) as {
	clientId: string;
	headers: Record<string, string>;
};

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

export function deriveBaseUrl(token: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return DEFAULT_BASE_URL;
	const host = match[1].replace(/^proxy\./, "api.");
	return `https://${host}`;
}

export async function exchangeToken(refreshToken: string): Promise<{ access: string; expires: number; baseUrl: string }> {
	const response = await fetch(COPILOT_TOKEN_URL, {
		method: "GET",
		headers: {
			...copilotConfig.headers,
			Accept: "application/json",
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

export function createCopilotProvider(auth: StoredAuth, configDir?: string): Provider {
	const resolvedConfigDir = configDir ?? path.join(os.homedir(), ".config", "bobai");

	// Mutable session state
	let sessionToken = auth.access;
	let sessionExpires = auth.expires;
	let baseUrl = deriveBaseUrl(auth.access);
	const refreshToken = auth.refresh;

	// Per-turn tracking
	let turnStartTime = 0;
	let turnModel = "";
	let turnAgentCalls = 0;
	let turnUserCalls = 0;
	let turnPremiumCost = 0;
	let turnTokens = 0;
	let turnLastCallTokens = 0;
	let baselineTokens = 0;

	async function ensureValidSession(): Promise<void> {
		if (Date.now() < sessionExpires) return;
		const result = await exchangeToken(refreshToken);
		sessionToken = result.access;
		sessionExpires = result.expires;
		baseUrl = result.baseUrl;
		saveAuth(resolvedConfigDir, { refresh: refreshToken, access: sessionToken, expires: sessionExpires });
	}

	return {
		id: "github-copilot",

		beginTurn() {
			turnStartTime = performance.now();
			turnModel = "";
			turnAgentCalls = 0;
			turnUserCalls = 0;
			turnPremiumCost = 0;
			turnTokens = 0;
			baselineTokens = turnLastCallTokens;
			turnLastCallTokens = 0;
		},

		getTurnSummary(): string | undefined {
			if (turnStartTime === 0) return undefined;
			const elapsed = (performance.now() - turnStartTime) / 1000;
			const contextDelta = turnLastCallTokens - baselineTokens;
			const sign = contextDelta > 0 ? "+" : "";
			const parts = [
				turnModel,
				`agent: ${turnAgentCalls}`,
				`user: ${turnUserCalls}`,
				`premium: ${turnPremiumCost.toFixed(2)}`,
				`tokens: ${turnTokens}`,
				`context: ${sign}${contextDelta}`,
				`${elapsed.toFixed(2)}s`,
			];
			return ` | ${parts.join(" | ")}`;
		},

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			await ensureValidSession();
			const initiator = options.initiator ?? resolveInitiator(options.messages);

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...copilotConfig.headers,
					"Openai-Intent": "conversation-edits",
					Authorization: `Bearer ${sessionToken}`,
					"x-initiator": initiator,
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
					const promptTokens = data.usage?.prompt_tokens ?? 0;
					const totalTokens = data.usage?.total_tokens ?? 0;
					const configs = loadModelsConfig(resolvedConfigDir);
					const contextWindow = configs.find((m) => m.id === options.model)?.contextWindow ?? 0;
					const display = formatModelDisplay(options.model, promptTokens, resolvedConfigDir);

					yield { type: "usage" as const, tokenCount: promptTokens, tokenLimit: contextWindow, display };

					// Accumulate per-turn stats
					turnModel = options.model;
					turnTokens += totalTokens;
					turnLastCallTokens = promptTokens;
					if (initiator === "agent") turnAgentCalls++;
					else turnUserCalls++;
					const multiplier = PREMIUM_REQUEST_MULTIPLIERS[options.model as keyof typeof PREMIUM_REQUEST_MULTIPLIERS] ?? 0;
					if (initiator === "user") turnPremiumCost += multiplier;

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

export async function enableModels(sessionToken: string, baseUrl: string, modelIds: string[]): Promise<void> {
	console.log("Enabling models");

	const results = await Promise.all(
		modelIds.map(async (id) => {
			try {
				const response = await fetch(`${baseUrl}/models/${id}/policy`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...copilotConfig.headers,
						"openai-intent": "chat-policy",
						"x-interaction-type": "chat-policy",
						Authorization: `Bearer ${sessionToken}`,
					},
					body: JSON.stringify({ state: "enabled" }),
				});
				if (response.ok) {
					return { id, status: "enabled" };
				}
				return { id, status: `failed (HTTP ${response.status})` };
			} catch (err) {
				return { id, status: `failed (${err instanceof Error ? err.message : String(err)})` };
			}
		}),
	);

	for (const r of results) {
		console.log(`- ${r.id.padEnd(20)}: ${r.status}`);
	}
}

export interface RefreshResult {
	total: number;
	enabled: number;
	configPath: string;
}

export async function refreshModels(sessionToken: string, baseUrl: string, configDir: string): Promise<RefreshResult> {
	console.log("Fetching model catalog from models.dev");
	const catalog = await fetchCatalog("github-copilot");
	console.log(`- Got ${catalog.length} models`);
	const configs = buildModelConfigs(catalog);

	console.log("");
	await enableModels(
		sessionToken,
		baseUrl,
		configs.map((c) => c.id),
	);
	console.log("");

	console.log("Checking models");
	for (const config of configs) {
		process.stdout.write(`- ${config.id.padEnd(20)}`);
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...copilotConfig.headers,
					"Openai-Intent": "conversation-edits",
					Authorization: `Bearer ${sessionToken}`,
					"x-initiator": "agent",
				},
				body: JSON.stringify({
					model: config.id,
					messages: [{ role: "user", content: "Ping. Respond pong." }],
					stream: false,
				}),
				signal: AbortSignal.timeout(20_000),
			});
			if (response.ok) {
				config.enabled = true;
				console.log(": OK");
			} else {
				console.log(`: failed (HTTP ${response.status})`);
			}
		} catch (err) {
			console.log(`: failed (${err instanceof Error ? err.message : "unknown error"})`);
		}
	}

	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, "copilot-models.json");
	fs.writeFileSync(configPath, JSON.stringify(configs, null, "\t"));

	const enabled = configs.filter((c) => c.enabled).length;
	console.log("");
	console.log(`Wrote ${configs.length} models (${enabled} enabled) to ${configPath}`);

	return { total: configs.length, enabled, configPath };
}
