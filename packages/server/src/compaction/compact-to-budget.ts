import type { Logger } from "../log/logger";
import type { Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import { compactMessages } from "./engine";
import { evictOldTurns } from "./eviction";
import { computeCharBudget, DEFAULT_THRESHOLD, PRESSURE_STEP, totalContentChars } from "./strength";

export interface CompactToBudgetOptions {
	messages: Message[];
	contextWindow: number;
	promptTokens: number;
	promptChars: number;
	target: number;
	tools: ToolRegistry;
	sessionId?: string;
	onReadFileCompacted?: (toolCallId: string, callArgs: Record<string, unknown>) => void;
	logger?: Logger;
}

export interface CompactToBudgetResult {
	messages: Message[];
	pressure: number;
	iterations: number;
	charsBefore: number;
	charsAfter: number;
	charBudget: number;
}

/**
 * Iteratively compact messages until they fit within a character budget.
 *
 * Converts the model's context window (in tokens) to a character budget using
 * the session's measured charsPerToken ratio, then increases compaction pressure
 * in PRESSURE_STEP increments until the total message content fits.
 *
 * Returns the original messages unchanged when:
 * - No valid charsPerToken ratio is available (first turn)
 * - Content already fits within the budget
 */
export function compactToBudget(options: CompactToBudgetOptions): CompactToBudgetResult {
	const { messages, contextWindow, promptTokens, promptChars, target, tools, sessionId, logger } = options;

	const charBudget = computeCharBudget(contextWindow, target, promptTokens, promptChars);
	const charsBefore = totalContentChars(messages);

	// No valid ratio available — skip compaction
	if (charBudget <= 0) {
		return {
			messages,
			pressure: 0,
			iterations: 0,
			charsBefore,
			charsAfter: charsBefore,
			charBudget: 0,
		};
	}

	// Already fits — no compaction needed
	if (charsBefore <= charBudget) {
		return {
			messages,
			pressure: 0,
			iterations: 0,
			charsBefore,
			charsAfter: charsBefore,
			charBudget,
		};
	}

	const startTime = performance.now();

	// To produce a specific pressure P from computeContextPressure:
	//   P = (usage - threshold) / (1 - threshold)
	//   usage = promptTokens / contextWindow
	//   So: promptTokens = contextWindow * (P * (1 - threshold) + threshold)
	// We use a synthetic contextWindow of 100000 to keep values clean.
	const syntheticContextWindow = 100_000;

	let bestMessages = messages;
	let bestCharsAfter = charsBefore;
	let iterations = 0;
	let finalPressure = 0;

	for (let pressure = PRESSURE_STEP; pressure <= 1.0 + 1e-9; pressure += PRESSURE_STEP) {
		iterations++;
		const clampedPressure = Math.min(pressure, 1.0);
		const syntheticPromptTokens = Math.round(
			syntheticContextWindow * (clampedPressure * (1 - DEFAULT_THRESHOLD) + DEFAULT_THRESHOLD),
		);

		// onReadFileCompacted may fire on multiple iterations (idempotent —
		// FileTime.invalidate is a simple Map delete, negligible overhead).
		const compacted = compactMessages({
			messages,
			context: {
				promptTokens: syntheticPromptTokens,
				contextWindow: syntheticContextWindow,
			},
			tools,
			sessionId,
			onReadFileCompacted: options.onReadFileCompacted,
		});

		const evicted = evictOldTurns(compacted);
		const charsAfter = totalContentChars(evicted);

		bestMessages = evicted;
		bestCharsAfter = charsAfter;
		finalPressure = clampedPressure;

		if (charsAfter <= charBudget) {
			break;
		}
	}

	const elapsed = performance.now() - startTime;
	logger?.debug(
		"COMPACTION",
		`compactToBudget: ${iterations} iterations in ${elapsed.toFixed(1)}ms, ` +
			`chars ${charsBefore} → ${bestCharsAfter} (budget: ${charBudget}, pressure: ${finalPressure.toFixed(2)})`,
	);

	return {
		messages: bestMessages,
		pressure: finalPressure,
		iterations,
		charsBefore,
		charsAfter: bestCharsAfter,
		charBudget,
	};
}
