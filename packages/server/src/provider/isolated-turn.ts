import { PREMIUM_REQUEST_MULTIPLIERS } from "./copilot-models";
import type { Provider, ProviderOptions, StreamEvent } from "./provider";

/**
 * Create a provider wrapper with isolated turn-tracking state.
 * Delegates stream() to the original provider with an onMetrics callback
 * that routes metric accumulation to this wrapper's local variables
 * instead of the original provider's closure-scoped state.
 *
 * Used for parallel task execution where multiple subagents need
 * independent turn metrics without corrupting each other or the parent.
 */
export function createIsolatedTurnProvider(original: Provider): Provider {
	let turnStartTime = 0;
	let turnModel = "";
	let turnAgentCalls = 0;
	let turnUserCalls = 0;
	let turnPremiumCost = 0;
	let turnTokens = 0;
	let turnLastCallTokens = 0;
	let turnLastCallChars = 0;
	let baselineTokens = 0;

	return {
		id: original.id,

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield* original.stream({
				...options,
				onMetrics(metrics) {
					turnModel = metrics.model;
					turnTokens += metrics.totalTokens;
					turnLastCallTokens = metrics.promptTokens;
					turnLastCallChars = metrics.promptChars;
					if (metrics.initiator === "agent") turnAgentCalls++;
					else turnUserCalls++;
					const multiplier = PREMIUM_REQUEST_MULTIPLIERS[metrics.model] ?? 0;
					if (metrics.initiator === "user") turnPremiumCost += multiplier;
				},
			});
		},

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
				turnLastCallChars?: number;
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
	};
}
