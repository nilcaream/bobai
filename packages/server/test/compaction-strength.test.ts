import { describe, expect, test } from "bun:test";
import {
	AGE_INFLECTION,
	AGE_STEEPNESS,
	computeAge,
	computeCompactionFactor,
	computeContextPressure,
	DEFAULT_THRESHOLD,
} from "../src/compaction/strength";

describe("computeContextPressure", () => {
	test("returns 0 when contextWindow is 0", () => {
		expect(computeContextPressure({ promptTokens: 100, contextWindow: 0 })).toBe(0);
	});

	test("returns 0 when contextWindow is negative", () => {
		expect(computeContextPressure({ promptTokens: 100, contextWindow: -1000 })).toBe(0);
	});

	test("returns 0 when usage is below default threshold (50%)", () => {
		expect(computeContextPressure({ promptTokens: 400, contextWindow: 1000 })).toBe(0);
	});

	test("returns 0 when usage is exactly at threshold", () => {
		expect(computeContextPressure({ promptTokens: 500, contextWindow: 1000 })).toBe(0);
	});

	test("returns positive when usage is above threshold", () => {
		const pressure = computeContextPressure({ promptTokens: 700, contextWindow: 1000 });
		expect(pressure).toBeGreaterThan(0);
	});

	test("scales linearly from 0 to 1 between threshold and full", () => {
		// At 80% usage with default 50% threshold: (0.8 - 0.5) / (1 - 0.5) = 0.6
		const pressure = computeContextPressure({ promptTokens: 800, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.6, 10);
	});

	test("returns 1.0 when context is fully used", () => {
		expect(computeContextPressure({ promptTokens: 1000, contextWindow: 1000 })).toBe(1);
	});

	test("clamps to 1.0 when usage exceeds context window", () => {
		expect(computeContextPressure({ promptTokens: 2000, contextWindow: 1000 })).toBe(1);
	});

	test("custom threshold works correctly", () => {
		// 50% usage with 60% threshold -> below threshold -> 0
		expect(computeContextPressure({ promptTokens: 500, contextWindow: 1000, threshold: 0.6 })).toBe(0);

		// 80% usage with 60% threshold -> (0.8 - 0.6) / (1 - 0.6) = 0.5
		const pressure = computeContextPressure({
			promptTokens: 800,
			contextWindow: 1000,
			threshold: 0.6,
		});
		expect(pressure).toBeCloseTo(0.5, 10);
	});

	test("usage at 70% with default threshold gives 0.4", () => {
		// (0.7 - 0.5) / (1 - 0.5) = 0.2 / 0.5 = 0.4
		const pressure = computeContextPressure({ promptTokens: 700, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.4, 10);
	});

	test("DEFAULT_THRESHOLD is 0.5", () => {
		expect(DEFAULT_THRESHOLD).toBe(0.5);
	});
});

describe("computeAge", () => {
	test("returns 0 when totalMessages is 0", () => {
		expect(computeAge(0, 0)).toBe(0);
	});

	test("returns 0 when totalMessages is 1", () => {
		expect(computeAge(0, 1)).toBe(0);
	});

	test("first message (index 0) has age 1.0", () => {
		expect(computeAge(0, 10)).toBe(1);
	});

	test("last message has age 0.0", () => {
		expect(computeAge(9, 10)).toBe(0);
	});

	test("AGE_INFLECTION is 0.8", () => {
		expect(AGE_INFLECTION).toBe(0.8);
	});

	test("AGE_STEEPNESS is 10", () => {
		expect(AGE_STEEPNESS).toBe(10);
	});

	test("age follows arctan S-curve", () => {
		const total = 5;
		const ages = Array.from({ length: total }, (_, i) => computeAge(i, total));
		// With inflection=0.8 and steepness=10, the S-curve protects the newest 20%
		// and aggressively compacts older messages.
		// positions: [0.0, 0.25, 0.5, 0.75, 1.0]
		expect(ages[0]).toBe(1); // oldest
		expect(ages[1]).toBeCloseTo(0.9783, 3); // position 0.25: still very old
		expect(ages[2]).toBeCloseTo(0.9227, 3); // position 0.5: above inflection, high age
		expect(ages[3]).toBeCloseTo(0.6151, 3); // position 0.75: near inflection, dropping
		expect(ages[4]).toBe(0); // newest
	});

	test("messages near inflection point have age around 0.43", () => {
		// Position 0.8 is the inflection. In a 101-message conversation,
		// index 80 has position ~0.8. The normalized atan curve is slightly
		// asymmetric, so the inflection maps to ~0.43 rather than exactly 0.5.
		const age = computeAge(80, 101);
		expect(age).toBeCloseTo(0.43, 1);
	});

	test("arctan curve gives sharper transition than quadratic", () => {
		// At position 0.5 (mid-conversation), quadratic gives 0.25 (low age),
		// but arctan with inflection=0.7 gives ~0.85 (high age) — much more aggressive.
		const age = computeAge(5, 11); // position 0.5
		expect(age).toBeGreaterThan(0.8);
	});
});

describe("computeCompactionFactor", () => {
	test("returns 0 when contextPressure is 0", () => {
		expect(computeCompactionFactor(0, 0.95)).toBe(0);
	});

	test("returns 0 when age is 0", () => {
		expect(computeCompactionFactor(0.6, 0)).toBe(0);
	});

	test("returns the product of contextPressure and age", () => {
		expect(computeCompactionFactor(1, 1)).toBe(1);
		expect(computeCompactionFactor(0.5, 1)).toBeCloseTo(0.5, 10);
		expect(computeCompactionFactor(1, 0.5)).toBeCloseTo(0.5, 10);
		expect(computeCompactionFactor(0.5, 0.5)).toBeCloseTo(0.25, 10);
	});

	test("example: computeCompactionFactor(0.6, 0.95) ≈ 0.57", () => {
		expect(computeCompactionFactor(0.6, 0.95)).toBeCloseTo(0.57, 2);
	});
});
