import type { Provider, ProviderOptions, StreamEvent } from "./provider";
import { getProviderDescriptor } from "./registry";

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
	let turnInputTokens = 0;
	let turnOutputTokens = 0;
	let turnTotalInputTokens = 0;
	let turnTotalOutputTokens = 0;
	let turnLastCallChars = 0;
	let baselineTokens = 0;

	return {
		id: original.id,

		async *stream(options: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield* original.stream({
				...options,
				onMetrics(metrics) {
					turnModel = metrics.model;
					turnInputTokens = metrics.promptTokens;
					turnOutputTokens = metrics.outputTokens;
					turnTotalInputTokens += metrics.promptTokens;
					turnTotalOutputTokens += metrics.outputTokens;
					turnLastCallChars = metrics.promptChars;
				},
			});
		},

		beginTurn(sessionPromptTokens?: number) {
			turnStartTime = performance.now();
			turnModel = "";
			turnInputTokens = 0;
			turnOutputTokens = 0;
			turnTotalInputTokens = 0;
			turnTotalOutputTokens = 0;
			turnLastCallChars = 0;
			baselineTokens = sessionPromptTokens || 0;
		},

		getTurnSummary(): string | undefined {
			if (turnStartTime === 0 || !turnModel) return undefined;
			const elapsed = (performance.now() - turnStartTime) / 1000;
			const descriptor = getProviderDescriptor(original.id);
			const contextDelta = turnInputTokens - baselineTokens;
			const contextSign = contextDelta > 0 ? "+" : "";
			const summaryParts = descriptor?.buildTurnSummaryParts?.({
				modelId: turnModel,
				inputTokens: turnTotalInputTokens,
				outputTokens: turnTotalOutputTokens,
			}) ?? {
				modelName: turnModel.includes("/") ? (turnModel.split("/").at(-1) ?? turnModel) : turnModel,
			};
			const parts = [summaryParts.modelName];
			if (summaryParts.pricingLabel) {
				parts.push(summaryParts.pricingLabel);
			}
			parts.push(`in: ${turnTotalInputTokens}`);
			parts.push(`out: ${turnTotalOutputTokens}`);
			if (summaryParts.costEstimate) {
				parts.push(summaryParts.costEstimate === "free" ? "free" : `estimate: ${summaryParts.costEstimate}`);
			}
			parts.push(`context: ${contextSign}${contextDelta}`);
			parts.push(`${elapsed.toFixed(2)}s`);
			return ` | ${parts.join(" | ")}`;
		},

		getTurnPromptTokens(): number {
			return turnInputTokens;
		},

		getTurnPromptChars(): number {
			return turnLastCallChars;
		},

		getTurnMetrics() {
			return {
				inputTokensTotal: turnTotalInputTokens,
				outputTokensTotal: turnTotalOutputTokens,
				inputTokensLast: turnInputTokens,
				outputTokensLast: turnOutputTokens,
				contextDelta: turnInputTokens - baselineTokens,
			};
		},

		saveTurnState(): unknown {
			return {
				turnStartTime,
				turnModel,
				turnInputTokens,
				turnOutputTokens,
				turnTotalInputTokens,
				turnTotalOutputTokens,
				turnLastCallChars,
				baselineTokens,
			};
		},

		restoreTurnState(state: unknown): void {
			const s = state as {
				turnStartTime: number;
				turnModel: string;
				turnInputTokens: number;
				turnOutputTokens: number;
				turnTotalInputTokens?: number;
				turnTotalOutputTokens?: number;
				turnLastCallChars?: number;
				baselineTokens: number;
			};
			turnStartTime = s.turnStartTime;
			turnModel = s.turnModel;
			turnInputTokens = s.turnInputTokens;
			turnOutputTokens = s.turnOutputTokens;
			turnTotalInputTokens = s.turnTotalInputTokens ?? s.turnInputTokens;
			turnTotalOutputTokens = s.turnTotalOutputTokens ?? s.turnOutputTokens;
			turnLastCallChars = s.turnLastCallChars ?? 0;
			baselineTokens = s.baselineTokens;
		},
	};
}
