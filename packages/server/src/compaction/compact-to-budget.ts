import type { Logger } from "../log/logger";
import type { Message } from "../provider/provider";
import type { ToolRegistry } from "../tool/tool";
import type { CompactionDetail } from "./engine";
import { compactMessages, compactMessagesWithStats } from "./engine";
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
	/** Post-compaction + post-eviction messages — what gets sent to the LLM. */
	messages: Message[];
	/** Post-compaction, pre-eviction messages (for dump files). */
	compacted: Message[];
	/** The multiplier used for compaction (higher = less aggressive). */
	multiplier: number;
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
 * the highest multiplier where the total message content fits.
 *
 * Higher multiplier → less compaction → more chars.
 * Lower multiplier → more compaction → fewer chars.
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
			multiplier: 0,
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
			multiplier: 0,
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

	// Binary search for the highest multiplier (0.01 precision) where compacted
	// content fits within the character budget.  Higher multiplier → less
	// compaction → more chars.  Lower multiplier → more compaction → fewer chars.
	// Search: find the highest multiplier that satisfies the budget.
	const MAX_ITERATIONS = 20;

	// Search bounds in integer centiles: 1..500 → multiplier 0.01..5.00
	let lo = 1;
	let hi = 500;
	let iterations = 0;
	let bestMultiplier = 0;

	/** Run compaction at a given centile and return the char count. */
	function probe(centile: number): number {
		const multiplier = centile / 100;

		const compacted = compactMessages({
			messages,
			multiplier,
			tools,
			sessionId,
			onReadFileCompacted: options.onReadFileCompacted,
		});

		return totalContentChars(compacted);
	}

	while (lo <= hi && iterations < MAX_ITERATIONS) {
		iterations++;
		const mid = Math.floor((lo + hi) / 2);
		const charsAfter = probe(mid);

		if (charsAfter <= charBudget) {
			// Fits! Record and try higher (less aggressive)
			bestMultiplier = mid / 100;
			lo = mid + 1;
		} else {
			// Doesn't fit — try lower (more aggressive)
			hi = mid - 1;
		}
	}

	if (iterations >= MAX_ITERATIONS) {
		// Safety: binary search should converge in ceil(log2(500)) = 9 iterations.
		// If we hit this, something is wrong — log a warning.
		logger?.warn(
			"COMPACTION",
			`binary search reached ${MAX_ITERATIONS} iterations without converging ` +
				`(lo=${lo}, hi=${hi}), using multiplier=${bestMultiplier.toFixed(2)}`,
		);
	}

	// If no multiplier fit the budget (even 0.01), use minimum multiplier as best effort.
	if (bestMultiplier === 0) {
		bestMultiplier = 0.01;
		logger?.warn(
			"COMPACTION",
			`no multiplier fits budget ${charBudget}, using minimum multiplier=${bestMultiplier.toFixed(2)}`,
		);
	}

	// Re-run compaction at the converged multiplier to collect per-tool details
	// and produce the actual message arrays for the caller.
	const {
		messages: finalMessages,
		preEviction,
		details,
	} = compactMessagesWithStats({
		messages,
		multiplier: bestMultiplier,
		tools,
		sessionId,
	});
	const finalCharsAfter = totalContentChars(finalMessages);

	const elapsed = performance.now() - startTime;
	logger?.debug(
		"COMPACTION",
		`budget: ${charBudget}, multiplier: ${bestMultiplier.toFixed(2)}, iterations: ${iterations}, ` +
			`time: ${elapsed.toFixed(1)}ms, chars: ${charsPerToken.toFixed(2)}, ` +
			`in: ${charsBefore}, out: ${finalCharsAfter}, type: ${options.type}`,
	);

	return {
		messages: finalMessages,
		compacted: preEviction,
		multiplier: bestMultiplier,
		iterations,
		charsBefore,
		charsAfter: finalCharsAfter,
		charBudget,
		charsPerToken,
		details,
		elapsedMs: elapsed,
	};
}
