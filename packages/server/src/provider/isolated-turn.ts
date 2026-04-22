import { formatModelLabel } from "./copilot-models";
import { getProviderModelConfig } from "./models";
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
	let turnInputTokens = 0;
	let turnOutputTokens = 0;
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
					turnLastCallChars = metrics.promptChars;
				},
			});
		},

		beginTurn(sessionPromptTokens?: number) {
			turnStartTime = performance.now();
			turnModel = "";
			turnInputTokens = 0;
			turnOutputTokens = 0;
			turnLastCallChars = 0;
			baselineTokens = sessionPromptTokens || 0;
		},

		getTurnSummary(): string | undefined {
			if (turnStartTime === 0 || !turnModel) return undefined;
			const elapsed = (performance.now() - turnStartTime) / 1000;
			const modelConfig =
				original.id === "github-copilot" || original.id === "openrouter"
					? getProviderModelConfig(original.id, turnModel)
					: undefined;
			const modelName = turnModel.includes("/") ? (turnModel.split("/").at(-1) ?? turnModel) : turnModel;
			const contextDelta = turnInputTokens - baselineTokens;
			const contextSign = contextDelta > 0 ? "+" : "";
			const parts = [modelName];
			if (original.id === "github-copilot") {
				parts.push(modelConfig?.label ?? formatModelLabel(turnModel));
			}
			parts.push(`in: ${turnInputTokens}`);
			parts.push(`out: ${turnOutputTokens}`);
			if (original.id === "openrouter") {
				if (modelConfig?.label === "free") {
					parts.push("free");
				} else if (modelConfig?.inputPrice !== undefined && modelConfig.outputPrice !== undefined) {
					const cost = (turnInputTokens * modelConfig.inputPrice + turnOutputTokens * modelConfig.outputPrice) / 1_000_000;
					parts.push(`estimate: $${cost.toFixed(2)}`);
				}
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

		saveTurnState(): unknown {
			return {
				turnStartTime,
				turnModel,
				turnInputTokens,
				turnOutputTokens,
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
				turnLastCallChars?: number;
				baselineTokens: number;
			};
			turnStartTime = s.turnStartTime;
			turnModel = s.turnModel;
			turnInputTokens = s.turnInputTokens;
			turnOutputTokens = s.turnOutputTokens;
			turnLastCallChars = s.turnLastCallChars ?? 0;
			baselineTokens = s.baselineTokens;
		},
	};
}
