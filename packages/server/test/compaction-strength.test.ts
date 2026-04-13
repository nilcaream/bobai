import { describe, expect, test } from "bun:test";
import {
	computeCharBudget,
	computeCompactionFactor,
	DEFAULT_MAX_DISTANCE,
	EMERGENCY_TARGET,
	PRE_PROMPT_TARGET,
	totalContentChars,
} from "../src/compaction/strength";

describe("computeCompactionFactor", () => {
	test("newest message (distance 0) has factor 0", () => {
		expect(computeCompactionFactor(0, 1.0, 300)).toBe(0);
	});

	test("exactly at maxDistance gives factor 1.0", () => {
		expect(computeCompactionFactor(300, 1.0, 300)).toBe(1.0);
	});

	test("beyond maxDistance is clamped to 1.0", () => {
		expect(computeCompactionFactor(600, 1.0, 300)).toBe(1.0);
	});

	test("midpoint gives factor 0.5", () => {
		expect(computeCompactionFactor(150, 1.0, 300)).toBe(0.5);
	});

	test("multiplier doubles effective range", () => {
		// 150 / (2.0 * 300) = 150 / 600 = 0.25
		expect(computeCompactionFactor(150, 2.0, 300)).toBe(0.25);
	});

	test("multiplier halves effective range, clamped at 1.0", () => {
		// 150 / (0.5 * 300) = 150 / 150 = 1.0
		expect(computeCompactionFactor(150, 0.5, 300)).toBe(1.0);
	});

	test("zero multiplier returns 1.0", () => {
		expect(computeCompactionFactor(100, 0, 300)).toBe(1.0);
	});

	test("zero maxDistance returns 1.0", () => {
		expect(computeCompactionFactor(100, 1.0, 0)).toBe(1.0);
	});
});

describe("DEFAULT_MAX_DISTANCE", () => {
	test("equals 10_000", () => {
		expect(DEFAULT_MAX_DISTANCE).toBe(10_000);
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
});
