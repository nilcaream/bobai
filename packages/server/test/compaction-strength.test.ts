import { describe, expect, test } from "bun:test";
import {
	AGE_INFLECTION,
	AGE_STEEPNESS,
	computeAge,
	computeContextPressure,
	computeMessageStrengths,
	computeStrength,
	DEFAULT_RESISTANCE,
	DEFAULT_THRESHOLD,
} from "../src/compaction/strength";
import type { Message } from "../src/provider/provider";

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

describe("computeStrength", () => {
	test("returns 0 when contextPressure is 0", () => {
		expect(computeStrength(0, 1, 0)).toBe(0);
	});

	test("returns 0 when contextPressure is negative", () => {
		expect(computeStrength(-0.5, 1, 0)).toBe(0);
	});

	test("full pressure, oldest message (age=1), zero resistance gives 1.0", () => {
		// 1.0 * 1.0 * 1.0 = 1.0
		expect(computeStrength(1, 1, 0)).toBe(1);
	});

	test("full pressure, newest message (age=0), zero resistance gives 0.0", () => {
		// 1.0 * 0.0 * 1.0 = 0.0 — age gates everything
		expect(computeStrength(1, 0, 0)).toBe(0);
	});

	test("full pressure, oldest message (age=1), full resistance gives 0.0", () => {
		// 1.0 * 1.0 * 0.0 = 0.0 — resistance gates everything
		expect(computeStrength(1, 1, 1)).toBe(0);
	});

	test("full pressure, newest message (age=0), full resistance gives 0.0", () => {
		// 1.0 * 0.0 * 0.0 = 0.0
		expect(computeStrength(1, 0, 1)).toBe(0);
	});

	test("half pressure scales result by half", () => {
		// 0.5 * 1.0 * 1.0 = 0.5
		expect(computeStrength(0.5, 1, 0)).toBeCloseTo(0.5, 10);
	});

	test("clamped to max 1.0", () => {
		// contextPressure=2 is out of normal range but tests clamping
		// 2.0 * 1.0 * 1.0 = 2.0 -> clamped to 1.0
		expect(computeStrength(2, 1, 0)).toBe(1);
	});

	test("DEFAULT_RESISTANCE is 0.3", () => {
		expect(DEFAULT_RESISTANCE).toBe(0.3);
	});

	test("default resistance value produces expected strength", () => {
		// Full pressure, oldest message, default resistance 0.3
		// 1.0 * 1.0 * 0.7 = 0.7
		expect(computeStrength(1, 1, DEFAULT_RESISTANCE)).toBeCloseTo(0.7, 10);
	});

	test("age=0 always produces strength=0 regardless of resistance", () => {
		// This is the key property of the multiplicative formula
		for (const resistance of [0, 0.1, 0.3, 0.5, 0.8, 1.0]) {
			expect(computeStrength(1.0, 0, resistance)).toBe(0);
		}
	});
});

describe("computeMessageStrengths", () => {
	const systemMsg: Message = { role: "system", content: "You are helpful." };
	const userMsg: Message = { role: "user", content: "Hello" };
	const assistantMsg: Message = { role: "assistant", content: "Hi there" };
	const toolMsg = (toolCallId: string): Message => ({
		role: "tool",
		content: "result",
		tool_call_id: toolCallId,
	});

	test("skips non-tool messages", () => {
		const messages: Message[] = [systemMsg, userMsg, assistantMsg];
		const result = computeMessageStrengths(messages, 1.0, () => 0);
		expect(result.size).toBe(0);
	});

	test("returns empty map when no tool messages exist", () => {
		const messages: Message[] = [systemMsg, userMsg, assistantMsg, userMsg];
		const result = computeMessageStrengths(messages, 1.0, () => 0);
		expect(result.size).toBe(0);
	});

	test("returns empty map when contextPressure is 0", () => {
		const messages: Message[] = [systemMsg, toolMsg("call_1"), toolMsg("call_2")];
		const result = computeMessageStrengths(messages, 0, () => 0);
		expect(result.size).toBe(0);
	});

	test("computes correct strengths for tool messages", () => {
		const messages: Message[] = [
			systemMsg, // index 0
			toolMsg("call_1"), // index 1
			userMsg, // index 2
			toolMsg("call_2"), // index 3
			assistantMsg, // index 4
		];
		const contextPressure = 1.0;
		const resistance = 0;

		const result = computeMessageStrengths(messages, contextPressure, () => resistance);

		// Only tool messages at indices 1 and 3 should be present
		expect(result.size).toBe(2);
		expect(result.has(1)).toBe(true);
		expect(result.has(3)).toBe(true);

		// index 1, total 5: arctan age ≈ 0.9783, resistance=0, compactability=1.0
		// strength = 1.0 * 0.9783 * 1.0 ≈ 0.9783
		const strength1 = result.get(1);
		expect(strength1).toBeDefined();
		expect(strength1).toBeCloseTo(0.9783, 3);

		// index 3, total 5: arctan age ≈ 0.6151, resistance=0, compactability=1.0
		// strength = 1.0 * 0.6151 * 1.0 ≈ 0.6151
		const strength3 = result.get(3);
		expect(strength3).toBeDefined();
		expect(strength3).toBeCloseTo(0.6151, 3);
	});

	test("uses getResistance callback with correct tool_call_id", () => {
		const messages: Message[] = [
			toolMsg("call_alpha"), // index 0
			toolMsg("call_beta"), // index 1
		];

		const calledWith: string[] = [];
		const getResistance = (toolCallId: string): number => {
			calledWith.push(toolCallId);
			return toolCallId === "call_alpha" ? 0.8 : 0.2;
		};

		const result = computeMessageStrengths(messages, 1.0, getResistance);

		expect(calledWith).toEqual(["call_alpha", "call_beta"]);

		// index 0, total 2: arctan age = 1.0 (oldest)
		// call_alpha resistance=0.8, compactability=0.2
		// strength = 1.0 * 1.0 * 0.2 = 0.2
		expect(result.get(0)).toBeCloseTo(0.2, 10);

		// index 1, total 2: arctan age = 0.0 (newest)
		// call_beta resistance=0.2, compactability=0.8
		// strength = 1.0 * 0.0 * 0.8 = 0.0 -> excluded
		expect(result.has(1)).toBe(false);
	});

	test("does not include entries with zero strength", () => {
		const messages: Message[] = [
			toolMsg("call_1"), // index 0, only message
		];

		// totalMessages=1 -> age=0, resistance=1 -> compactability=0
		// strength = 1.0 * 0 * 0 = 0 -> excluded
		const result = computeMessageStrengths(messages, 1.0, () => 1);
		expect(result.size).toBe(0);
	});

	test("handles empty message array", () => {
		const result = computeMessageStrengths([], 1.0, () => 0);
		expect(result.size).toBe(0);
	});

	test("handles mixed messages with varying resistance", () => {
		const messages: Message[] = [
			systemMsg, // index 0
			toolMsg("read_file"), // index 1
			assistantMsg, // index 2
			toolMsg("write_file"), // index 3
			userMsg, // index 4
			toolMsg("bash"), // index 5
		];

		const resistanceMap: Record<string, number> = {
			read_file: 0.0,
			write_file: 0.5,
			bash: 1.0,
		};

		const result = computeMessageStrengths(messages, 0.8, (id) => resistanceMap[id] ?? DEFAULT_RESISTANCE);

		// index 1, total 6: arctan age ≈ 0.9840, resistance=0.0, compactability=1.0
		// strength = 0.8 * 0.9840 * 1.0 ≈ 0.7872
		const strength1 = result.get(1);
		expect(strength1).toBeDefined();
		expect(strength1).toBeCloseTo(0.7872, 3);

		// index 3, total 6: arctan age ≈ 0.8671, resistance=0.5, compactability=0.5
		// strength = 0.8 * 0.8671 * 0.5 ≈ 0.3469
		const strength3 = result.get(3);
		expect(strength3).toBeDefined();
		expect(strength3).toBeCloseTo(0.3469, 3);

		// index 5, total 6: arctan age = 0.0, resistance=1.0, compactability=0.0
		// strength = 0.8 * 0.0 * 0.0 = 0.0 -> excluded
		expect(result.has(5)).toBe(false);
	});
});
