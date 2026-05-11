import { describe, expect, test } from "bun:test";
import {
	computeConservativePromptTokenEstimate,
	computeSafeMaxOutputTokens,
	DEFAULT_FALLBACK_CHARS_PER_TOKEN,
	OUTPUT_TOKEN_HEADROOM,
} from "../src/provider/output-budget";

describe("output budget helper", () => {
	test("returns configured maxOutput when prompt estimate leaves enough room", () => {
		const result = computeSafeMaxOutputTokens({
			contextWindow: 100000,
			configuredMaxOutput: 20000,
			messageChars: 10000,
			sessionPromptTokens: 1000,
			sessionPromptChars: 4000,
		});

		expect(result).toBe(20000);
	});

	test("clips output when prompt estimate approaches context window", () => {
		const result = computeSafeMaxOutputTokens({
			contextWindow: 1000,
			configuredMaxOutput: 400,
			messageChars: 3200,
			sessionPromptTokens: 100,
			sessionPromptChars: 400,
		});

		expect(result).toBe(190);
	});

	test("uses stored prompt tokens as a lower bound", () => {
		const result = computeConservativePromptTokenEstimate({
			messageChars: 100,
			sessionPromptTokens: 700,
			sessionPromptChars: 3500,
		});

		expect(result).toBe(700);
	});

	test("falls back to conservative chars/token estimate when no history exists", () => {
		const result = computeConservativePromptTokenEstimate({
			messageChars: 1000,
			sessionPromptTokens: 0,
			sessionPromptChars: 0,
		});

		expect(result).toBe(Math.ceil(1000 / DEFAULT_FALLBACK_CHARS_PER_TOKEN));
	});

	test("never returns less than 1", () => {
		const result = computeSafeMaxOutputTokens({
			contextWindow: 100,
			configuredMaxOutput: 50,
			messageChars: 100000,
			sessionPromptTokens: 0,
			sessionPromptChars: 0,
		});

		expect(result).toBe(1);
	});

	test("reserves output token headroom", () => {
		const result = computeSafeMaxOutputTokens({
			contextWindow: 1000,
			configuredMaxOutput: 500,
			messageChars: 2000,
			sessionPromptTokens: 100,
			sessionPromptChars: 400,
		});

		const estimatedPromptTokens = computeConservativePromptTokenEstimate({
			messageChars: 2000,
			sessionPromptTokens: 100,
			sessionPromptChars: 400,
		});
		expect(result).toBe(1000 - estimatedPromptTokens - OUTPUT_TOKEN_HEADROOM);
	});

	test("falls back to chars-based estimate when stale floor overflows window", () => {
		// Simulates post-compaction: messages compacted to ~100k token equivalent,
		// but sessionPromptTokens=205k from the previous uncompacted turn.
		// contextWindow=200k (user-set limit). Without the fix, the 205k floor
		// pushes estimatedPromptTokens to 205k, leaving 0 room for output.
		const result = computeSafeMaxOutputTokens({
			contextWindow: 200000,
			configuredMaxOutput: 16384,
			messageChars: 350000, // ~100k tokens at 3.5 ratio
			sessionPromptTokens: 205000, // stale — post-compaction payload is smaller
			sessionPromptChars: 717500, // charsPerToken = 3.5
		});

		// Fallback: charsBased = ceil(350000 / 3.5) = 100000
		// remaining = 200000 - 100000 - 10 = 99990
		// result = min(16384, 99990) = 16384 — full output budget restored
		expect(result).toBe(16384);
	});

	test("keeps floor when it does not overflow window", () => {
		// Normal case: floor is below the window, so it's preserved.
		// messageChars=100 → charsBased ≈ 29, sessionPromptTokens=700 → floor = 700
		// 700 < 100000 - 10, so no overflow. Floor is used as-is.
		const result = computeSafeMaxOutputTokens({
			contextWindow: 100000,
			configuredMaxOutput: 16384,
			messageChars: 100,
			sessionPromptTokens: 700,
			sessionPromptChars: 3500,
		});

		// estimatedPromptTokens = max(29, 700) = 700, not overflowing
		// remaining = 100000 - 700 - 10 = 99290
		expect(result).toBe(16384);
	});
});
