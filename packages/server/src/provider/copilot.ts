import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type StoredAuth, saveAuth } from "../auth/store";
import type { Logger } from "../log/logger";
import { fetchCatalog } from "../models-catalog";
import { convertMessagesToAnthropic, convertToolsToAnthropic } from "./anthropic-convert";
import { parseAnthropicStream } from "./anthropic-stream";
import { buildModelConfigs, formatModelDisplay, getPremiumRequestMultiplier, loadModelsConfig } from "./copilot-models";
import type { Message, Provider, ProviderOptions, StreamEvent } from "./provider";
import { AuthError, ProviderError, TimeoutError } from "./provider";
import { convertMessagesToResponses, convertToolsToResponses } from "./responses-convert";
import { parseResponsesSSE } from "./responses-stream";
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
	let response: Response;
	try {
		response = await fetch(COPILOT_TOKEN_URL, {
			method: "GET",
			headers: {
				...copilotConfig.headers,
				Accept: "application/json",
				Authorization: `Bearer ${refreshToken}`,
			},
		});
	} catch (err) {
		// Network error (ConnectionRefused, DNS failure, etc.)
		const message = err instanceof Error ? err.message : String(err);
		throw new AuthError(0, `Token exchange network error: ${message}`, false);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		const permanent = response.status === 401 || response.status === 403;
		throw new AuthError(response.status, `Token exchange failed: ${response.status} ${body}`, permanent);
	}

	const data = (await response.json()) as { token?: string; expires_at?: number };

	if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
		throw new AuthError(0, "Invalid token exchange response: missing token or expires_at", false);
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

export function isCopilotClaude(modelId: string): boolean {
	return /^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId);
}

/**
 * Models that require the OpenAI Responses API instead of Chat Completions.
 * GPT-5+ (except gpt-5-mini which works fine with Chat Completions).
 */
export function isCopilotResponses(modelId: string): boolean {
	const match = /^gpt-(\d+)/.exec(modelId);
	if (!match) return false;
	return Number(match[1]) >= 5 && !modelId.startsWith("gpt-5-mini");
}

export function createCopilotProvider(
	auth: StoredAuth,
	configDir?: string,
	logger?: Logger,
	/** @internal — exposed for unit tests to avoid multi-second backoff waits */
	testOverrides?: { backoffBaseMs?: number; bodyTimeoutMs?: number },
): Provider {
	const resolvedConfigDir = configDir ?? path.join(os.homedir(), ".config", "bobai");

	// Mutable session state
	let sessionToken = auth.access;
	let sessionExpires = auth.expires;
	let baseUrl = deriveBaseUrl(auth.access);
	const refreshToken = auth.refresh;

	// Warn about potentially corrupt refresh token
	if (refreshToken.startsWith("gho_") && refreshToken.length < 20) {
		const msg = `Refresh token looks corrupt: prefix=gho_ len=${refreshToken.length} (expected 40+). Run 'bobai auth' to re-authenticate.`;
		logger?.warn("AUTH", msg);
		console.warn(`[WARN] ${msg}`);
	}

	// Per-turn tracking
	let turnStartTime = 0;
	let turnModel = "";
	let turnAgentCalls = 0;
	let turnUserCalls = 0;
	let turnPremiumCost = 0;
	let turnTokens = 0;
	let turnLastCallTokens = 0;
	let turnLastCallChars = 0;
	let baselineTokens = 0;
	const warnedContextWindow = new Set<string>();

	// Coalescing promise: when a refresh is in-flight, concurrent callers
	// await the same promise instead of issuing duplicate token exchanges.
	let refreshInFlight: Promise<void> | null = null;

	function tokenSummary(token: string): string {
		const prefix = token.slice(0, 4);
		const type = token.startsWith("tid=") ? "session" : token.startsWith("gho_") ? "oauth" : "unknown";
		return `type=${type} prefix=${prefix}... len=${token.length}`;
	}

	async function ensureValidSession(): Promise<void> {
		const now = Date.now();
		if (now < sessionExpires) {
			logger?.debug("AUTH", `Session valid (expires in ${Math.round((sessionExpires - now) / 1000)}s, baseUrl=${baseUrl})`);
			return;
		}

		if (refreshInFlight) {
			logger?.debug("AUTH", "Token refresh already in-flight, waiting");
			await refreshInFlight;
			return;
		}

		logger?.info(
			"AUTH",
			`Session token expired (expired ${Math.round((now - sessionExpires) / 1000)}s ago), refreshing. ` +
				`refresh=${tokenSummary(refreshToken)} session=${tokenSummary(sessionToken)} baseUrl=${baseUrl}`,
		);

		refreshInFlight = (async () => {
			const result = await exchangeToken(refreshToken);
			sessionToken = result.access;
			sessionExpires = result.expires;
			baseUrl = result.baseUrl;
			saveAuth(resolvedConfigDir, { refresh: refreshToken, access: sessionToken, expires: sessionExpires });
			logger?.info("AUTH", `Token refreshed successfully. session=${tokenSummary(sessionToken)} baseUrl=${baseUrl}`);
		})();

		try {
			await refreshInFlight;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger?.error("AUTH", `Token refresh failed: ${msg}. refresh=${tokenSummary(refreshToken)}`);
			throw err;
		} finally {
			refreshInFlight = null;
		}
	}

	function getMaxOutputTokens(modelId: string): number {
		const configs = loadModelsConfig(resolvedConfigDir);
		const config = configs.find((m) => m.id === modelId);
		return config?.maxOutput ?? 16384;
	}

	// ── Shared retry infrastructure ──────────────────────────────────────

	const MAX_RETRIES = 3;
	const REQUEST_TIMEOUT_MS = 120_000;
	const BODY_TIMEOUT_MS = testOverrides?.bodyTimeoutMs ?? 120_000;
	const BACKOFF_MS = testOverrides?.backoffBaseMs ?? 10_000;

	/** Extract an HTTP status code from an error thrown by fetch() or the Anthropic SDK. */
	function errorStatus(err: unknown): number {
		if (typeof err === "object" && err !== null) {
			const obj = err as Record<string, unknown>;
			if (typeof obj.status === "number") return obj.status;
			if (typeof obj.statusCode === "number") return obj.statusCode;
		}
		return 0;
	}

	function errorMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === "object" && err !== null) {
			const msg = (err as Record<string, unknown>).message;
			if (typeof msg === "string") return msg;
		}
		return String(err);
	}

	/**
	 * Rolling timer that serves as both connection timeout and body-read watchdog.
	 * Starts with `initialMs`; call `reset(ms)` to restart with a new duration.
	 * When the timer fires it aborts via the given controller.
	 */
	function createRollingTimer(
		controller: AbortController,
		initialMs: number,
	): { reset: (ms: number) => void; clear: () => void; readonly fired: boolean } {
		let id: ReturnType<typeof setTimeout> | undefined;
		let fired = false;
		const fire = () => {
			fired = true;
			controller.abort();
		};
		id = setTimeout(fire, initialMs);
		return {
			reset(ms: number) {
				if (id !== undefined) clearTimeout(id);
				id = setTimeout(fire, ms);
			},
			clear() {
				if (id !== undefined) {
					clearTimeout(id);
					id = undefined;
				}
			},
			get fired() {
				return fired;
			},
		};
	}

	// ── Anthropic (Claude) streaming path ────────────────────────────────

	async function* streamClaude(
		options: ProviderOptions,
		initiator: "user" | "agent",
		callChars: number,
	): AsyncGenerator<StreamEvent> {
		const { system, messages } = convertMessagesToAnthropic(options.messages);
		const tools = options.tools?.length ? convertToolsToAnthropic(options.tools) : undefined;
		const maxTokens = getMaxOutputTokens(options.model);

		const params: Record<string, unknown> = {
			model: options.model,
			messages,
			max_tokens: maxTokens,
			...(system ? { system } : {}),
			...(tools ? { tools } : {}),
		};

		let lastError: unknown;
		let retriedAuth = false;
		let downgradeWarned = false;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const effectiveInitiator = attempt > 0 ? "agent" : initiator;
			if (attempt === 1 && initiator === "user" && !downgradeWarned) {
				downgradeWarned = true;
				logger?.warn("RETRY", `Downgrading x-initiator from "user" to "agent" for retry to protect premium quota`);
			}

			const controller = new AbortController();
			const signals: AbortSignal[] = [controller.signal];
			if (options.signal) signals.push(options.signal);
			const combinedSignal = AbortSignal.any(signals);
			const timer = createRollingTimer(controller, REQUEST_TIMEOUT_MS);

			try {
				const client = new Anthropic({
					// apiKey: null suppresses the SDK's default env-var lookup
					// (ANTHROPIC_API_KEY). Without it, an unrelated env var could
					// override our Copilot session token and route requests to
					// api.anthropic.com instead of the Copilot proxy.
					apiKey: null,
					// authToken makes the SDK send "Authorization: Bearer <token>"
					// (not "x-api-key"), which is what Copilot's proxy expects.
					authToken: sessionToken,
					baseURL: baseUrl,
					// The SDK has built-in retry logic (default: 2 retries). We must
					// disable it because our own retry loop handles x-initiator
					// downgrade, token refresh, and body-read timeout — the SDK's
					// retries would bypass all of that and send duplicate requests
					// with the original headers.
					maxRetries: 0,
					defaultHeaders: {
						...copilotConfig.headers,
						"Openai-Intent": "conversation-edits",
						"x-initiator": effectiveInitiator,
					},
				});

				const anthropicStream = client.messages.stream(params, { signal: combinedSignal });
				anthropicStream.on("connect", () => timer.reset(BODY_TIMEOUT_MS));

				for await (const event of parseAnthropicStream(anthropicStream, options.model, effectiveInitiator, resolvedConfigDir)) {
					timer.reset(BODY_TIMEOUT_MS);
					if (event.type === "usage") {
						if (options.onMetrics) {
							options.onMetrics({
								model: options.model,
								promptTokens: event.tokenCount,
								promptChars: callChars,
								totalTokens: event.tokenCount,
								initiator: effectiveInitiator,
							});
						} else {
							turnModel = options.model;
							turnTokens += event.tokenCount;
							turnLastCallTokens = event.tokenCount;
							turnLastCallChars = callChars;
							if (effectiveInitiator === "agent") turnAgentCalls++;
							else turnUserCalls++;
							const multiplier = getPremiumRequestMultiplier(options.model) ?? 0;
							if (effectiveInitiator === "user") turnPremiumCost += multiplier;
						}
					}
					yield event;
				}
				timer.clear();
				return;
			} catch (err: unknown) {
				timer.clear();

				// If the CALLER aborted (not our timeout), do not retry
				if (options.signal?.aborted) {
					throw err;
				}

				lastError = err;
				const status = errorStatus(err);
				const isTimeout = timer.fired;

				logger?.warn(
					"RETRY",
					`Anthropic stream attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ` +
						`${isTimeout ? "timeout" : `status=${status || "network"}`} ${errorMessage(err).slice(0, 200)}`,
				);

				// Non-retryable 4xx (except 429) — fail immediately unless auth retry
				if (status !== 429 && status >= 400 && status < 500) {
					if ((status === 401 || status === 400) && !retriedAuth) {
						retriedAuth = true;
						logger?.warn(
							"AUTH",
							`Got ${status} from Anthropic messages (${errorMessage(err).slice(0, 200)}), ` +
								`forcing token refresh. session=${tokenSummary(sessionToken)} baseUrl=${baseUrl}`,
						);
						sessionExpires = 0;
						await ensureValidSession();
						continue;
					}
					throw new ProviderError(status, errorMessage(err));
				}

				// Retryable: 429, 5xx, network/timeout errors
				if (attempt === MAX_RETRIES) {
					throw isTimeout ? new TimeoutError(MAX_RETRIES + 1, lastError) : lastError;
				}
				await new Promise((r) => setTimeout(r, BACKOFF_MS));
				await ensureValidSession();
			}
		}

		throw lastError ?? new Error("Unexpected: no response after retry loop");
	}

	// ── OpenAI Responses API streaming path ──────────────────────────────

	async function* streamResponses(
		options: ProviderOptions,
		initiator: "user" | "agent",
		callChars: number,
	): AsyncGenerator<StreamEvent> {
		const input = convertMessagesToResponses(options.messages);
		const tools = options.tools?.length ? convertToolsToResponses(options.tools) : undefined;

		let lastError: unknown;
		let retriedAuth = false;
		let downgradeWarned = false;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const effectiveInitiator = attempt > 0 ? "agent" : initiator;
			if (attempt === 1 && initiator === "user" && !downgradeWarned) {
				downgradeWarned = true;
				logger?.warn("RETRY", `Downgrading x-initiator from "user" to "agent" for retry to protect premium quota`);
			}

			const controller = new AbortController();
			const signals: AbortSignal[] = [controller.signal];
			if (options.signal) signals.push(options.signal);
			const combinedSignal = AbortSignal.any(signals);
			const timer = createRollingTimer(controller, REQUEST_TIMEOUT_MS);

			let response: Response | undefined;

			try {
				response = await fetch(`${baseUrl}/responses`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...copilotConfig.headers,
						"Openai-Intent": "conversation-edits",
						Authorization: `Bearer ${sessionToken}`,
						"x-initiator": effectiveInitiator,
					},
					body: JSON.stringify({
						model: options.model,
						input,
						...(tools ? { tools } : {}),
						stream: true,
						store: false,
						reasoning: { effort: "medium", summary: "auto" },
						include: ["reasoning.encrypted_content"],
					}),
					signal: combinedSignal,
				});
				// Headers received — switch from connection timeout to body watchdog
				timer.reset(BODY_TIMEOUT_MS);
			} catch (err) {
				timer.clear();
				// If the CALLER aborted (not our timeout), do not retry
				if (options.signal?.aborted) {
					throw err;
				}
				lastError = err;
				const isTimeout = timer.fired;
				logger?.warn(
					"RETRY",
					`Responses fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ` +
						`${isTimeout ? "timeout" : "network"} ${errorMessage(err).slice(0, 200)}`,
				);
				if (attempt === MAX_RETRIES) {
					throw isTimeout ? new TimeoutError(MAX_RETRIES + 1, lastError) : lastError;
				}
				await new Promise((r) => setTimeout(r, BACKOFF_MS));
				await ensureValidSession();
				continue;
			}

			if (!response.ok) {
				timer.clear();

				if (response.status !== 429 && response.status < 500) {
					if ((response.status === 401 || response.status === 400) && !retriedAuth) {
						const body = await response.text();
						retriedAuth = true;
						logger?.warn(
							"AUTH",
							`Got ${response.status} from responses (body: ${body.slice(0, 200)}), ` +
								`forcing token refresh. session=${tokenSummary(sessionToken)} baseUrl=${baseUrl}`,
						);
						sessionExpires = 0;
						await ensureValidSession();
						continue;
					}
					throw new ProviderError(response.status, await response.text());
				}

				// Retryable: 429 or 5xx
				lastError = new ProviderError(response.status, await response.text());
				if (attempt === MAX_RETRIES) throw lastError;

				await new Promise((r) => setTimeout(r, BACKOFF_MS));
				await ensureValidSession();
				continue;
			}

			if (!response.body) {
				timer.clear();
				yield { type: "finish" as const, reason: "stop" as const };
				return;
			}

			try {
				for await (const event of parseResponsesSSE(response.body, options.model, effectiveInitiator, resolvedConfigDir)) {
					timer.reset(BODY_TIMEOUT_MS);
					if (event.type === "usage") {
						if (options.onMetrics) {
							options.onMetrics({
								model: options.model,
								promptTokens: event.tokenCount,
								promptChars: callChars,
								totalTokens: event.tokenCount,
								initiator: effectiveInitiator,
							});
						} else {
							turnModel = options.model;
							turnTokens += event.tokenCount;
							turnLastCallTokens = event.tokenCount;
							turnLastCallChars = callChars;
							if (effectiveInitiator === "agent") turnAgentCalls++;
							else turnUserCalls++;
							const multiplier = getPremiumRequestMultiplier(options.model) ?? 0;
							if (effectiveInitiator === "user") turnPremiumCost += multiplier;
						}
					}
					yield event;
				}
				timer.clear();
				return;
			} catch (err) {
				timer.clear();

				// If the CALLER aborted (not our timeout), do not retry
				if (options.signal?.aborted) {
					throw err;
				}

				// Body-read error (timeout or network) — treat as retryable
				lastError = err;
				const isTimeout = timer.fired;
				logger?.warn(
					"RETRY",
					`Responses stream attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ` +
						`${isTimeout ? "timeout" : "network"} ${errorMessage(err).slice(0, 200)}`,
				);
				if (attempt === MAX_RETRIES) {
					throw isTimeout ? new TimeoutError(MAX_RETRIES + 1, lastError) : lastError;
				}
				await new Promise((r) => setTimeout(r, BACKOFF_MS));
				await ensureValidSession();
			}
		}

		throw lastError ?? new Error("Unexpected: no response after retry loop");
	}

	return {
		id: "github-copilot",

		beginTurn(sessionPromptTokens?: number) {
			turnStartTime = performance.now();
			turnModel = "";
			turnAgentCalls = 0;
			turnUserCalls = 0;
			turnPremiumCost = 0;
			turnTokens = 0;
			turnLastCallTokens = 0;
			turnLastCallChars = 0;
			baselineTokens = sessionPromptTokens || 0;
		},

		getTurnSummary(): string | undefined {
			if (turnStartTime === 0) return undefined;
			const elapsed = (performance.now() - turnStartTime) / 1000;
			let contextDisplay: string;
			if (baselineTokens === 0) {
				// New session or new subagent — show absolute context size
				contextDisplay = `context: ${turnLastCallTokens}`;
			} else {
				const contextDelta = turnLastCallTokens - baselineTokens;
				const sign = contextDelta > 0 ? "+" : "";
				contextDisplay = `context: ${sign}${contextDelta}`;
			}
			const parts = [
				turnModel,
				`agent: ${turnAgentCalls}`,
				`user: ${turnUserCalls}`,
				`premium: ${turnPremiumCost.toFixed(2)}`,
				`tokens: ${turnTokens}`,
				contextDisplay,
				`${elapsed.toFixed(2)}s`,
			];
			return ` | ${parts.join(" | ")}`;
		},

		getTurnPromptTokens(): number {
			return turnLastCallTokens;
		},

		getTurnPromptChars(): number {
			return turnLastCallChars;
		},

		saveTurnState(): unknown {
			return {
				turnStartTime,
				turnModel,
				turnAgentCalls,
				turnUserCalls,
				turnPremiumCost,
				turnTokens,
				turnLastCallTokens,
				turnLastCallChars,
				baselineTokens,
			};
		},

		restoreTurnState(state: unknown): void {
			const s = state as {
				turnStartTime: number;
				turnModel: string;
				turnAgentCalls: number;
				turnUserCalls: number;
				turnPremiumCost: number;
				turnTokens: number;
				turnLastCallTokens: number;
				turnLastCallChars: number;
				baselineTokens: number;
			};
			turnStartTime = s.turnStartTime;
			turnModel = s.turnModel;
			turnAgentCalls = s.turnAgentCalls;
			turnUserCalls = s.turnUserCalls;
			turnPremiumCost = s.turnPremiumCost;
			turnTokens = s.turnTokens;
			turnLastCallTokens = s.turnLastCallTokens;
			turnLastCallChars = s.turnLastCallChars ?? 0;
			baselineTokens = s.baselineTokens;
		},

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			await ensureValidSession();
			const initiator = options.initiator ?? resolveInitiator(options.messages);

			// Compute total content + tool_call argument chars for the messages
			// being sent. Must stay consistent with totalContentChars() in
			// compaction/strength.ts — both count the same message payloads so
			// the derived charsPerToken ratio is self-consistent.
			let callChars = 0;
			for (const msg of options.messages) {
				if ("content" in msg && typeof msg.content === "string") {
					callChars += msg.content.length;
				}
				if ("tool_calls" in msg && Array.isArray(msg.tool_calls)) {
					for (const tc of msg.tool_calls) {
						callChars += tc.function.arguments.length;
					}
				}
			}

			if (isCopilotClaude(options.model)) {
				yield* streamClaude(options, initiator, callChars);
				return;
			}

			if (isCopilotResponses(options.model)) {
				yield* streamResponses(options, initiator, callChars);
				return;
			}

			// ── OpenAI Chat Completions path ─────────────────────────────

			let lastError: unknown;
			let retriedAuth = false;
			let downgradeWarned = false;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				const effectiveInitiator = attempt > 0 ? "agent" : initiator;
				if (attempt === 1 && initiator === "user" && !downgradeWarned) {
					downgradeWarned = true;
					logger?.warn("RETRY", `Downgrading x-initiator from "user" to "agent" for retry to protect premium quota`);
				}

				const controller = new AbortController();
				const signals: AbortSignal[] = [controller.signal];
				if (options.signal) signals.push(options.signal);
				const combinedSignal = AbortSignal.any(signals);
				const timer = createRollingTimer(controller, REQUEST_TIMEOUT_MS);

				let response: Response | undefined;

				try {
					response = await fetch(`${baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...copilotConfig.headers,
							"Openai-Intent": "conversation-edits",
							Authorization: `Bearer ${sessionToken}`,
							"x-initiator": effectiveInitiator,
						},
						body: JSON.stringify({
							model: options.model,
							messages: options.messages,
							stream: true,
							...(options.tools?.length ? { tools: options.tools } : {}),
						}),
						signal: combinedSignal,
					});
					// Headers received — switch from connection timeout to body watchdog
					timer.reset(BODY_TIMEOUT_MS);
				} catch (err) {
					timer.clear();
					// If the CALLER aborted (not our timeout), do not retry
					if (options.signal?.aborted) {
						throw err;
					}
					lastError = err;
					const isTimeout = timer.fired;
					logger?.warn(
						"RETRY",
						`OpenAI fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ` +
							`${isTimeout ? "timeout" : "network"} ${errorMessage(err).slice(0, 200)}`,
					);
					// Timeout errors and network errors are retryable; fall through to backoff
					if (attempt === MAX_RETRIES) {
						throw isTimeout ? new TimeoutError(MAX_RETRIES + 1, lastError) : lastError;
					}
					await new Promise((r) => setTimeout(r, BACKOFF_MS));
					await ensureValidSession();
					continue;
				}

				if (!response.ok) {
					timer.clear();

					// Non-retryable 4xx (except 429) — fail immediately
					// Special cases:
					// - 401 might mean server-side token revocation.
					// - 400 "badly formatted" can mean a corrupt/stale session token.
					// Force one token refresh and retry before giving up.
					if (response.status !== 429 && response.status < 500) {
						if ((response.status === 401 || response.status === 400) && !retriedAuth) {
							const body = await response.text();
							retriedAuth = true;
							logger?.warn(
								"AUTH",
								`Got ${response.status} from chat/completions (body: ${body.slice(0, 200)}), ` +
									`forcing token refresh. session=${tokenSummary(sessionToken)} baseUrl=${baseUrl}`,
							);
							sessionExpires = 0; // Force ensureValidSession to refresh
							await ensureValidSession();
							continue;
						}
						throw new ProviderError(response.status, await response.text());
					}

					// Retryable: 429 or 5xx
					lastError = new ProviderError(response.status, await response.text());
					if (attempt === MAX_RETRIES) throw lastError;

					await new Promise((r) => setTimeout(r, BACKOFF_MS));
					await ensureValidSession();
					continue;
				}

				if (!response.body) {
					timer.clear();
					yield { type: "finish" as const, reason: "stop" as const };
					return;
				}

				try {
					for await (const event of parseSSE(response.body)) {
						timer.reset(BODY_TIMEOUT_MS);

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
							if (contextWindow <= 0 && !warnedContextWindow.has(options.model)) {
								warnedContextWindow.add(options.model);
								console.warn(`[WARN] No contextWindow for model "${options.model}"; context tracking degraded`);
							}
							const display = formatModelDisplay(options.model, promptTokens, resolvedConfigDir);

							yield { type: "usage" as const, tokenCount: promptTokens, tokenLimit: contextWindow, display };

							// Accumulate per-turn stats — route to external callback if provided,
							// otherwise update the provider's own closure-scoped variables.
							if (options.onMetrics) {
								options.onMetrics({
									model: options.model,
									promptTokens,
									promptChars: callChars,
									totalTokens,
									initiator: effectiveInitiator,
								});
							} else {
								turnModel = options.model;
								turnTokens += totalTokens;
								turnLastCallTokens = promptTokens;
								turnLastCallChars = callChars;
								if (effectiveInitiator === "agent") turnAgentCalls++;
								else turnUserCalls++;
								const multiplier = getPremiumRequestMultiplier(options.model) ?? 0;
								if (effectiveInitiator === "user") turnPremiumCost += multiplier;
							}

							const reason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
							yield { type: "finish" as const, reason } as StreamEvent;
							timer.clear();
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

					timer.clear();
					yield { type: "finish" as const, reason: "stop" as const };
					return;
				} catch (err) {
					timer.clear();

					// If the CALLER aborted (not our timeout), do not retry
					if (options.signal?.aborted) {
						throw err;
					}

					// Body-read error (timeout or network) — treat as retryable
					lastError = err;
					const isTimeout = timer.fired;
					logger?.warn(
						"RETRY",
						`OpenAI body-read attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ` +
							`${isTimeout ? "timeout" : "network"} ${errorMessage(err).slice(0, 200)}`,
					);
					if (attempt === MAX_RETRIES) {
						throw isTimeout ? new TimeoutError(MAX_RETRIES + 1, lastError) : lastError;
					}
					await new Promise((r) => setTimeout(r, BACKOFF_MS));
					await ensureValidSession();
				}
			}

			throw lastError ?? new Error("Unexpected: no response after retry loop");
		},
	};
}

export async function enableModels(sessionToken: string, baseUrl: string, modelIds: string[], padWidth = 20): Promise<void> {
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
		console.log(`- ${r.id.padEnd(padWidth)} : ${r.status}`);
	}
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
	options?: { verify?: boolean },
): Promise<RefreshResult> {
	console.log("Fetching model catalog from models.dev");
	const catalog = await fetchCatalog("github-copilot");
	console.log(`- Got ${catalog.length} models`);
	const configs = buildModelConfigs(catalog);

	if (!options?.verify) {
		for (const config of configs) {
			config.enabled = true;
		}
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, "copilot-models.json");
		fs.writeFileSync(configPath, JSON.stringify(configs, null, "\t"));
		console.log("");
		console.log(`Wrote ${configs.length} models (curated list) to ${configPath}`);
		console.log("Run `bobai refresh --verify` to verify that curated models are currently available.");
		return { total: configs.length, enabled: configs.length, configPath };
	}

	const padWidth = Math.max(...configs.map((c) => c.id.length), 0);

	console.log("");
	await enableModels(
		sessionToken,
		baseUrl,
		configs.map((c) => c.id),
		padWidth,
	);
	console.log("");

	console.log("Checking models");
	for (const config of configs) {
		process.stdout.write(`- ${config.id.padEnd(padWidth)} : `);
		try {
			let response: Response;
			if (isCopilotClaude(config.id)) {
				response = await fetch(`${baseUrl}/v1/messages`, {
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
						max_tokens: 16,
						stream: false,
					}),
					signal: AbortSignal.timeout(40_000),
				});
			} else if (isCopilotResponses(config.id)) {
				response = await fetch(`${baseUrl}/responses`, {
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
						input: [{ role: "user", content: [{ type: "input_text", text: "Ping. Respond pong." }] }],
						stream: false,
						store: false,
					}),
					signal: AbortSignal.timeout(40_000),
				});
			} else {
				response = await fetch(`${baseUrl}/chat/completions`, {
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
					signal: AbortSignal.timeout(40_000),
				});
			}
			if (response.ok) {
				config.enabled = true;
				console.log("OK");
			} else {
				console.log(`failed (HTTP ${response.status})`);
			}
		} catch (err) {
			console.log(`failed (${err instanceof Error ? err.message : "unknown error"})`);
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
