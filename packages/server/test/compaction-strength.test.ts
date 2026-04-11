import { describe, expect, test } from "bun:test";
import {
	AGE_INFLECTION,
	AGE_STEEPNESS,
	computeAge,
	computeCharBudget,
	computeCompactionFactor,
	computeContextPressure,
	DEFAULT_THRESHOLD,
	EMERGENCY_TARGET,
	MAX_AGE_DISTANCE,
	PRE_PROMPT_TARGET,
	totalContentChars,
	USAGE_STEP,
} from "../src/compaction/strength";

describe("computeContextPressure", () => {
	test("returns 0 when contextWindow is 0", () => {
		expect(computeContextPressure({ promptTokens: 100, contextWindow: 0 })).toBe(0);
	});

	test("returns 0 when contextWindow is negative", () => {
		expect(computeContextPressure({ promptTokens: 100, contextWindow: -1000 })).toBe(0);
	});

	test("returns 0 when usage is below default threshold (20%)", () => {
		expect(computeContextPressure({ promptTokens: 100, contextWindow: 1000 })).toBe(0);
	});

	test("returns 0 when usage is exactly at threshold", () => {
		expect(computeContextPressure({ promptTokens: 200, contextWindow: 1000 })).toBe(0);
	});

	test("returns positive when usage is above threshold", () => {
		const pressure = computeContextPressure({ promptTokens: 700, contextWindow: 1000 });
		expect(pressure).toBeGreaterThan(0);
	});

	test("scales linearly from 0 to 1 between threshold and full", () => {
		// At 80% usage with default 20% threshold: (0.8 - 0.2) / (1 - 0.2) = 0.75
		const pressure = computeContextPressure({ promptTokens: 800, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.75, 10);
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

	test("usage at 50% with default threshold gives 0.375", () => {
		// (0.5 - 0.2) / (1 - 0.2) = 0.3 / 0.8 = 0.375
		const pressure = computeContextPressure({ promptTokens: 500, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.375, 10);
	});

	test("DEFAULT_THRESHOLD is 0.2", () => {
		expect(DEFAULT_THRESHOLD).toBe(0.2);
	});
});

describe("computeAge", () => {
	test("returns 0 when totalMessages is 0", () => {
		expect(computeAge(0, 0)).toBe(0);
	});

	test("returns 0 when totalMessages is 1", () => {
		expect(computeAge(0, 1)).toBe(0);
	});

	test("MAX_AGE_DISTANCE is 100", () => {
		expect(MAX_AGE_DISTANCE).toBe(100);
	});

	test("AGE_INFLECTION is 0.7", () => {
		expect(AGE_INFLECTION).toBe(0.7);
	});

	test("AGE_STEEPNESS is 5", () => {
		expect(AGE_STEEPNESS).toBe(5);
	});

	test("last message always has age 0.0", () => {
		expect(computeAge(9, 10)).toBe(0);
		expect(computeAge(199, 200)).toBe(0);
		expect(computeAge(4, 5)).toBe(0);
	});

	test("messages at MAX_AGE_DISTANCE or further have age 1.0", () => {
		// In a 200-message conversation, idx 99 has distFromEnd=100, normPos=0.0
		expect(computeAge(99, 200)).toBe(1);
		// idx 0 has distFromEnd=199 > 100, capped to normPos=0.0
		expect(computeAge(0, 200)).toBe(1);
	});

	test("MAX_AGE_DISTANCE capping: messages far from end are equally compactable", () => {
		// In a 300-message conversation, message 0 and message 199 both have
		// distanceFromEnd >= 100, so they should have the same age.
		const age0 = computeAge(0, 300);
		const age199 = computeAge(199, 300);
		expect(age0).toBe(age199);
		expect(age0).toBe(1); // both fully compactable
	});

	test("age follows arctan S-curve within MAX_AGE_DISTANCE window", () => {
		// 200-message conversation where the capping window maps cleanly.
		// Messages within the last 100 get graduated protection.
		const total = 200;
		// idx=100: distFromEnd=99, normPos=0.01 → near oldest in window → age ≈ 0.998
		expect(computeAge(100, total)).toBeCloseTo(0.998, 2);
		// idx=140: distFromEnd=59, normPos=0.41 → moderate age
		expect(computeAge(140, total)).toBeCloseTo(0.857, 2);
		// idx=150: distFromEnd=49, normPos=0.51 → above inflection
		expect(computeAge(150, total)).toBeCloseTo(0.766, 2);
		// idx=180: distFromEnd=19, normPos=0.81 → well past inflection → low age
		expect(computeAge(180, total)).toBeCloseTo(0.211, 2);
		// idx=190: distFromEnd=9, normPos=0.91 → very protected
		expect(computeAge(190, total)).toBeCloseTo(0.076, 2);
		// idx=199: newest → 0
		expect(computeAge(199, total)).toBe(0);
	});

	test("messages near inflection point have age around 0.43", () => {
		// In a 101-message conversation, index 70 has distFromEnd=30,
		// normalizedPosition = 1 - 30/100 = 0.7 = AGE_INFLECTION.
		const age = computeAge(70, 101);
		expect(age).toBeCloseTo(0.43, 1);
	});

	test("short conversations: all messages are near-newest due to MAX_AGE_DISTANCE", () => {
		// In a 5-message conversation, the oldest message has distFromEnd=4,
		// normalizedPosition = 1 - 4/100 = 0.96 — nearly newest in the window.
		// So all messages get very low age (near 0).
		const ages = Array.from({ length: 5 }, (_, i) => computeAge(i, 5));
		// All ages should be very close to 0
		for (const age of ages) {
			expect(age).toBeLessThan(0.04);
		}
		// Oldest still has higher age than newest
		const ageNewest = ages[4] ?? 0;
		expect(ages[0]).toBeGreaterThan(ageNewest);
		// Exact values
		expect(ages[0]).toBeCloseTo(0.03, 2);
		expect(ages[4]).toBe(0);
	});

	test("arctan curve with distance-based age: old messages are fully compactable", () => {
		// In a 200-message conversation, idx=20 has distFromEnd=179 (>100),
		// so normalizedPosition=0 → age=1.0.
		// This is much higher than what a quadratic function would give at
		// the same position (position=20/199≈0.10, quadratic ≈ 0.81).
		const age = computeAge(20, 200);
		expect(age).toBe(1);
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

describe("computeCharBudget", () => {
	test("returns 0 when contextWindow is 0", () => {
		expect(computeCharBudget(0, 0.8, 1000, 3500)).toBe(0);
	});

	test("returns 0 when promptTokens is 0", () => {
		expect(computeCharBudget(100000, 0.8, 0, 0)).toBe(0);
	});

	test("returns 0 when promptChars is 0", () => {
		expect(computeCharBudget(100000, 0.8, 1000, 0)).toBe(0);
	});

	test("computes budget from measured ratio", () => {
		// charsPerToken = 3500 / 1000 = 3.5
		// budget = 100000 * 0.8 * 3.5 = 280000
		expect(computeCharBudget(100000, 0.8, 1000, 3500)).toBe(280000);
	});

	test("uses PRE_PROMPT_TARGET correctly", () => {
		// charsPerToken = 4000 / 1000 = 4.0
		// budget = 50000 * 0.8 * 4.0 = 160000
		expect(computeCharBudget(50000, PRE_PROMPT_TARGET, 1000, 4000)).toBe(160000);
	});

	test("uses EMERGENCY_TARGET correctly", () => {
		// charsPerToken = 4000 / 1000 = 4.0
		// budget = 50000 * 0.9 * 4.0 = 180000
		expect(computeCharBudget(50000, EMERGENCY_TARGET, 1000, 4000)).toBe(180000);
	});
});

describe("totalContentChars", () => {
	test("sums content across messages", () => {
		const messages = [
			{ content: "hello" }, // 5
			{ content: "world!!" }, // 7
		];
		expect(totalContentChars(messages)).toBe(12);
	});

	test("handles null and undefined content", () => {
		const messages = [{ content: null }, { content: "abc" }, { content: undefined }];
		expect(totalContentChars(messages)).toBe(3);
	});

	test("returns 0 for empty array", () => {
		expect(totalContentChars([])).toBe(0);
	});

	test("includes tool_calls arguments in char count", () => {
		const messages = [
			{ content: "hello" }, // 5
			{
				content: null,
				tool_calls: [
					{ function: { arguments: '{"path":"a.txt"}' } }, // 16
					{ function: { arguments: '{"cmd":"ls"}' } }, // 12
				],
			},
		];
		expect(totalContentChars(messages)).toBe(5 + 16 + 12);
	});

	test("counts both content and tool_calls on the same message", () => {
		const messages = [
			{
				content: "thinking...",
				tool_calls: [{ function: { arguments: '{"x":1}' } }],
			},
		];
		// "thinking..." = 11, '{"x":1}' = 7
		expect(totalContentChars(messages)).toBe(18);
	});
});

describe("compaction constants", () => {
	test("PRE_PROMPT_TARGET is 0.80", () => {
		expect(PRE_PROMPT_TARGET).toBe(0.8);
	});

	test("EMERGENCY_TARGET is 0.90", () => {
		expect(EMERGENCY_TARGET).toBe(0.9);
	});

	test("USAGE_STEP is 0.05", () => {
		expect(USAGE_STEP).toBe(0.05);
	});
});

describe("computeMinimumDistance", () => {
	const { computeMinimumDistance } = require("../src/compaction/strength");

	test("returns -1 when pressure is zero", () => {
		expect(computeMinimumDistance(0, 0.3, 200)).toBe(-1);
	});

	test("returns -1 when threshold is unreachable at max age", () => {
		// pressure=0.5, threshold=0.8 → max factor ≈ 0.5 < 0.8
		expect(computeMinimumDistance(0.5, 0.8, 200)).toBe(-1);
	});

	test("returns a positive distance when threshold is reachable", () => {
		// pressure=0.75 (usage=0.8), threshold=0.3
		const dist = computeMinimumDistance(0.75, 0.3, 200);
		expect(dist).toBeGreaterThan(0);
		expect(dist).toBeLessThanOrEqual(100); // MAX_AGE_DISTANCE
	});

	test("lower threshold requires smaller distance", () => {
		const distLow = computeMinimumDistance(0.75, 0.2, 200);
		const distHigh = computeMinimumDistance(0.75, 0.5, 200);
		expect(distLow).toBeGreaterThan(0);
		expect(distHigh).toBeGreaterThan(0);
		expect(distLow).toBeLessThan(distHigh);
	});

	test("higher pressure reaches threshold at smaller distance", () => {
		const distLowPressure = computeMinimumDistance(0.5, 0.3, 200);
		const distHighPressure = computeMinimumDistance(0.75, 0.3, 200);
		expect(distLowPressure).toBeGreaterThan(0);
		expect(distHighPressure).toBeGreaterThan(0);
		expect(distHighPressure).toBeLessThan(distLowPressure);
	});
});
