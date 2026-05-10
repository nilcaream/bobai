import type { ProviderModelConfig } from "./registry";

/**
 * Compute the dollar cost for a set of tokens, accounting for cache pricing.
 * Input tokens are split into regular, cache-read, and cache-write buckets,
 * each billed at the appropriate rate.
 */
export function computeTurnCostDollars(
	inputTokens: number,
	outputTokens: number,
	cachedInputTokens: number,
	cacheCreationInputTokens: number,
	modelConfig: ProviderModelConfig,
): number {
	const { inputPrice = 0, outputPrice = 0, cacheReadPrice, cacheWritePrice } = modelConfig;
	const regularInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens);
	const effectiveCacheReadPrice = cacheReadPrice ?? inputPrice;
	const effectiveCacheWritePrice = cacheWritePrice ?? inputPrice;

	return (
		(regularInput * inputPrice +
			cachedInputTokens * effectiveCacheReadPrice +
			cacheCreationInputTokens * effectiveCacheWritePrice +
			outputTokens * outputPrice) /
		1_000_000
	);
}

/**
 * Format a premium request total for display.
 * Strips trailing ".00" and unnecessary trailing zeros.
 */
export function formatPremiumRequests(total: number): string {
	const formatted = total.toFixed(2);
	if (formatted.endsWith(".00")) {
		return String(Number.parseInt(formatted, 10));
	}
	return String(Number.parseFloat(formatted));
}
