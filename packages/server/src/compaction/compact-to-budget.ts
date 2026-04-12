import type { Logger } from "../log/logger";
import type { Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import type { CompactionDetail } from "./engine";
import { compactMessages, compactMessagesWithStats } from "./engine";
import { evictOldTurns } from "./eviction";
import { computeCharBudget, totalContentChars } from "./strength";

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
	/** Post-eviction messages — what gets sent to the LLM. */
	messages: Message[];
	/** Pre-eviction compacted messages (same length as input). Needed by
	 *  mapEvictedToStored to map evicted messages back to original indices. */
	compacted: Message[];
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
 * the session's measured charsPerToken ratio, then uses binary search to find
 * the lowest compaction usage level where the total message content fits.
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
			compacted: messages,
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
			compacted: messages,
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

	// Binary search for the lowest usage (0.01 precision) where compacted
	// content fits within the character budget.  Compaction is monotonically
	// non-increasing: higher usage → equal or fewer chars.  This lets us use
	// binary search safely — if a midpoint fits, search lower; if not, search
	// higher.  Result: the tightest usage that satisfies the budget.
	const syntheticContextWindow = 100_000;
	const MAX_ITERATIONS = 20;

	// Search bounds in integer centiles: 1..100 → usage 0.01..1.00
	let lo = 1;
	let hi = 100;
	let iterations = 0;
	let finalUsage = 0;

	/** Run compaction + eviction at a given usage centile and return the char count. */
	function probe(centile: number): number {
		const usage = Math.min(centile / 100, 1.0);
		const syntheticPromptTokens = Math.round(syntheticContextWindow * usage);

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
		return totalContentChars(evicted);
	}

	while (lo <= hi && iterations < MAX_ITERATIONS) {
		iterations++;
		const mid = Math.floor((lo + hi) / 2);
		const charsAfter = probe(mid);

		if (charsAfter <= charBudget) {
			// Fits — record this usage and try lower (less aggressive compaction)
			finalUsage = mid / 100;
			hi = mid - 1;
		} else {
			// Doesn't fit — need higher usage (more aggressive compaction)
			lo = mid + 1;
		}
	}

	if (iterations >= MAX_ITERATIONS) {
		// Safety: binary search should converge in ceil(log2(100)) = 7 iterations.
		// If we hit this, something is wrong — log a warning.
		logger?.warn(
			"COMPACTION",
			`binary search reached ${MAX_ITERATIONS} iterations without converging ` +
				`(lo=${lo}, hi=${hi}), using usage=${finalUsage.toFixed(2)}`,
		);
	}

	// If no probe fit the budget, use maximum compaction as best effort.
	if (finalUsage === 0) {
		finalUsage = 1.0;
	}

	// Re-run compaction at the converged usage to collect per-tool details
	// and produce the actual message arrays for the caller.
	const finalSyntheticPromptTokens = Math.round(syntheticContextWindow * finalUsage);
	const { messages: finalCompacted, details } = compactMessagesWithStats({
		messages,
		context: {
			promptTokens: finalSyntheticPromptTokens,
			contextWindow: syntheticContextWindow,
		},
		tools,
		sessionId,
	});
	const finalEvicted = evictOldTurns(finalCompacted);
	const finalCharsAfter = totalContentChars(finalEvicted);

	const elapsed = performance.now() - startTime;
	logger?.debug(
		"COMPACTION",
		`budget: ${charBudget}, usage: ${finalUsage.toFixed(2)}, iterations: ${iterations}, ` +
			`time: ${elapsed.toFixed(1)}ms, chars: ${charsPerToken.toFixed(2)}, ` +
			`in: ${charsBefore}, out: ${finalCharsAfter}, type: ${options.type}`,
	);

	return {
		messages: finalEvicted,
		compacted: finalCompacted,
		usage: finalUsage,
		iterations,
		charsBefore,
		charsAfter: finalCharsAfter,
		charBudget,
		charsPerToken,
		details,
		elapsedMs: elapsed,
	};
}
