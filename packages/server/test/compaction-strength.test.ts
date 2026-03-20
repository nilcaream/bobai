import { describe, expect, test } from "bun:test";
import {
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

	test("returns 0 when usage is below default threshold (40%)", () => {
		expect(computeContextPressure({ promptTokens: 300, contextWindow: 1000 })).toBe(0);
	});

	test("returns 0 when usage is exactly at threshold", () => {
		expect(computeContextPressure({ promptTokens: 400, contextWindow: 1000 })).toBe(0);
	});

	test("returns positive when usage is above threshold", () => {
		const pressure = computeContextPressure({ promptTokens: 500, contextWindow: 1000 });
		expect(pressure).toBeGreaterThan(0);
	});

	test("scales linearly from 0 to 1 between threshold and full", () => {
		// At 70% usage with default 40% threshold: (0.7 - 0.4) / (1 - 0.4) = 0.5
		const pressure = computeContextPressure({ promptTokens: 700, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.5, 10);
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

	test("usage at 70% with default threshold gives 0.5", () => {
		// (0.7 - 0.4) / (1 - 0.4) = 0.3 / 0.6 = 0.5
		const pressure = computeContextPressure({ promptTokens: 700, contextWindow: 1000 });
		expect(pressure).toBeCloseTo(0.5, 10);
	});

	test("DEFAULT_THRESHOLD is 0.4", () => {
		expect(DEFAULT_THRESHOLD).toBe(0.4);
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

	test("middle message has age 0.5", () => {
		// index 5 out of 11 total: 1 - 5/10 = 0.5
		expect(computeAge(5, 11)).toBeCloseTo(0.5, 10);
	});

	test("age decreases linearly with index", () => {
		const total = 5;
		const ages = Array.from({ length: total }, (_, i) => computeAge(i, total));
		// [1.0, 0.75, 0.5, 0.25, 0.0]
		expect(ages[0]).toBe(1);
		expect(ages[1]).toBeCloseTo(0.75, 10);
		expect(ages[2]).toBeCloseTo(0.5, 10);
		expect(ages[3]).toBeCloseTo(0.25, 10);
		expect(ages[4]).toBe(0);
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
		// 1.0 * (1.0 + 1.0) / 2 = 1.0
		expect(computeStrength(1, 1, 0)).toBe(1);
	});

	test("full pressure, newest message (age=0), zero resistance gives 0.5", () => {
		// 1.0 * (0.0 + 1.0) / 2 = 0.5
		expect(computeStrength(1, 0, 0)).toBeCloseTo(0.5, 10);
	});

	test("full pressure, oldest message (age=1), full resistance gives 0.5", () => {
		// 1.0 * (1.0 + 0.0) / 2 = 0.5
		expect(computeStrength(1, 1, 1)).toBeCloseTo(0.5, 10);
	});

	test("full pressure, newest message (age=0), full resistance gives 0.0", () => {
		// 1.0 * (0.0 + 0.0) / 2 = 0.0
		expect(computeStrength(1, 0, 1)).toBe(0);
	});

	test("half pressure scales result by half", () => {
		// 0.5 * (1.0 + 1.0) / 2 = 0.5
		expect(computeStrength(0.5, 1, 0)).toBeCloseTo(0.5, 10);
	});

	test("clamped to max 1.0", () => {
		// contextPressure=2 is out of normal range but tests clamping
		// 2.0 * (1.0 + 1.0) / 2 = 2.0 -> clamped to 1.0
		expect(computeStrength(2, 1, 0)).toBe(1);
	});

	test("DEFAULT_RESISTANCE is 0.3", () => {
		expect(DEFAULT_RESISTANCE).toBe(0.3);
	});

	test("default resistance value produces expected strength", () => {
		// Full pressure, oldest message, default resistance 0.3
		// 1.0 * (1.0 + 0.7) / 2 = 0.85
		expect(computeStrength(1, 1, DEFAULT_RESISTANCE)).toBeCloseTo(0.85, 10);
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

		// index 1, total 5: age = 1 - 1/4 = 0.75
		// strength = 1.0 * (0.75 + 1.0) / 2 = 0.875
		expect(result.get(1)).toBeCloseTo(0.875, 10);

		// index 3, total 5: age = 1 - 3/4 = 0.25
		// strength = 1.0 * (0.25 + 1.0) / 2 = 0.625
		expect(result.get(3)).toBeCloseTo(0.625, 10);
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

		// index 0, total 2: age = 1 - 0/1 = 1.0
		// call_alpha resistance=0.8, compactability=0.2
		// strength = 1.0 * (1.0 + 0.2) / 2 = 0.6
		expect(result.get(0)).toBeCloseTo(0.6, 10);

		// index 1, total 2: age = 1 - 1/1 = 0.0
		// call_beta resistance=0.2, compactability=0.8
		// strength = 1.0 * (0.0 + 0.8) / 2 = 0.4
		expect(result.get(1)).toBeCloseTo(0.4, 10);
	});

	test("does not include entries with zero strength", () => {
		const messages: Message[] = [
			toolMsg("call_1"), // index 0, only message
		];

		// totalMessages=1 -> age=0, resistance=1 -> compactability=0
		// strength = 1.0 * (0 + 0) / 2 = 0 -> excluded
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

		// index 1, total 6: age = 1 - 1/5 = 0.8
		// read_file resistance=0.0, compactability=1.0
		// strength = 0.8 * (0.8 + 1.0) / 2 = 0.8 * 0.9 = 0.72
		expect(result.get(1)).toBeCloseTo(0.72, 10);

		// index 3, total 6: age = 1 - 3/5 = 0.4
		// write_file resistance=0.5, compactability=0.5
		// strength = 0.8 * (0.4 + 0.5) / 2 = 0.8 * 0.45 = 0.36
		expect(result.get(3)).toBeCloseTo(0.36, 10);

		// index 5, total 6: age = 1 - 5/5 = 0.0
		// bash resistance=1.0, compactability=0.0
		// strength = 0.8 * (0.0 + 0.0) / 2 = 0.0 -> excluded
		expect(result.has(5)).toBe(false);
	});
});
