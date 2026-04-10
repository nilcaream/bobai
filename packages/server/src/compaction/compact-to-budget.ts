import type { Logger } from "../log/logger";
import type { Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import type { CompactionDetail } from "./engine";
import { compactMessages, compactMessagesWithStats } from "./engine";
import { evictOldTurns } from "./eviction";
import { computeCharBudget, totalContentChars, USAGE_STEP } from "./strength";

export interface CompactToBudgetOptions {
	messages: Message[];
	contextWindow: number;
	promptTokens: number;
	promptChars: number;
	target: number;
	tools: ToolRegistry;
	/** Label for the log line: "pre-prompt" or "emergency". */
	type: "pre-prompt" | "emergency";
	sessionId?: string;
	onReadFileCompacted?: (toolCallId: string, callArgs: Record<string, unknown>) => void;
	logger?: Logger;
}

export interface CompactToBudgetResult {
	messages: Message[];
	/** The calculated compaction usage level (0.0-1.0). */
	usage: number;
	iterations: number;
	charsBefore: number;
	charsAfter: number;
	charBudget: number;
	charsPerToken: number;
	/** Per-tool-call compaction details from the final iteration. */
	details: Map<string, CompactionDetail>;
	/** Time spent on compaction in milliseconds. */
	elapsedMs: number;
}

/**
 * Iteratively compact messages until they fit within a character budget.
 *
 * Converts the model's context window (in tokens) to a character budget using
 * the session's measured charsPerToken ratio, then increases compaction usage
 * in USAGE_STEP increments until the total message content fits.
 *
 * Returns the original messages unchanged when:
 * - No valid charsPerToken ratio is available (first turn)
 * - Content already fits within the budget
 */
export function compactToBudget(options: CompactToBudgetOptions): CompactToBudgetResult {
	const { messages, contextWindow, promptTokens, promptChars, target, tools, sessionId, logger } = options;

	const charsPerToken = promptTokens > 0 && promptChars > 0 ? promptChars / promptTokens : 0;
	const charBudget = computeCharBudget(contextWindow, target, promptTokens, promptChars);
	const charsBefore = totalContentChars(messages);

	// No valid ratio available — skip compaction
	if (charBudget <= 0) {
		return {
			messages,
			usage: 0,
			iterations: 0,
			charsBefore,
			charsAfter: charsBefore,
			charBudget: 0,
			charsPerToken,
			details: new Map(),
			elapsedMs: 0,
		};
	}

	// Already fits — no compaction needed
	if (charsBefore <= charBudget) {
		return {
			messages,
			usage: 0,
			iterations: 0,
			charsBefore,
			charsAfter: charsBefore,
			charBudget,
			charsPerToken,
			details: new Map(),
			elapsedMs: 0,
		};
	}

	const startTime = performance.now();

	// Iterate usage from USAGE_STEP to 1.0. The compaction engine receives
	// usage as promptTokens/contextWindow and internally converts it to
	// pressure via the threshold function. We use a fixed synthetic
	// contextWindow and derive promptTokens = usage × contextWindow.
	const syntheticContextWindow = 100_000;

	let bestMessages = messages;
	let bestCharsAfter = charsBefore;
	let iterations = 0;
	let finalUsage = 0;

	for (let usage = USAGE_STEP; usage <= 1.0 + 1e-9; usage += USAGE_STEP) {
		iterations++;
		const clampedUsage = Math.min(usage, 1.0);
		const syntheticPromptTokens = Math.round(syntheticContextWindow * clampedUsage);

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
		finalUsage = clampedUsage;

		if (charsAfter <= charBudget) {
			break;
		}
	}

	// Collect per-tool details from the final usage level for observability.
	const finalSyntheticPromptTokens = Math.round(syntheticContextWindow * finalUsage);
	const { details } = compactMessagesWithStats({
		messages,
		context: {
			promptTokens: finalSyntheticPromptTokens,
			contextWindow: syntheticContextWindow,
		},
		tools,
		sessionId,
	});

	const elapsed = performance.now() - startTime;
	logger?.debug(
		"COMPACTION",
		`budget: ${charBudget}, usage: ${finalUsage.toFixed(2)}, iterations: ${iterations}, ` +
			`time: ${elapsed.toFixed(1)}ms, chars: ${charsPerToken.toFixed(2)}, ` +
			`in: ${charsBefore}, out: ${bestCharsAfter}, type: ${options.type}`,
	);

	return {
		messages: bestMessages,
		usage: finalUsage,
		iterations,
		charsBefore,
		charsAfter: bestCharsAfter,
		charBudget,
		charsPerToken,
		details,
		elapsedMs: elapsed,
	};
}
