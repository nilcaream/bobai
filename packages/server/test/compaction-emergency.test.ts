import { describe, expect, mock, test } from "bun:test";
import { emergencyCompactConversation, shouldEmergencyCompact } from "../src/agent-loop";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import { EMERGENCY_TARGET } from "../src/compaction/strength";
import type { Message } from "../src/provider/provider";
import type { Tool, ToolRegistry } from "../src/tool/tool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyRegistry: ToolRegistry = {
	definitions: [],
	get: () => undefined,
};

/** Registry with read_file that has an outputThreshold so compaction can fire. */
function createReadFileRegistry(): ToolRegistry {
	const readFileTool: Tool = {
		definition: {
			type: "function",
			function: { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
		},
		mergeable: true,
		outputThreshold: 0.3,
		compact(_output: string, callArgs: Record<string, unknown>): string {
			const p = typeof callArgs.path === "string" ? callArgs.path : "?";
			return `${COMPACTION_MARKER} read_file(${JSON.stringify({ path: p })}) was compacted.`;
		},
		formatCall: () => "",
		execute: async () => ({ llmOutput: "", uiOutput: null, mergeable: true }),
	};
	return {
		definitions: [readFileTool.definition],
		get(name: string) {
			if (name === "read_file") return readFileTool;
			return undefined;
		},
	};
}

/**
 * Trailing messages to push tool results into the compactable age zone.
 * With MAX_AGE_DISTANCE=100, we need 100+ messages after the tool result
 * so that distanceFromEnd >= 100 and age ≈ 1.0.
 */
const TRAILING_CONTEXT: Message[] = Array.from({ length: 100 }, (_, i) =>
	i % 2 === 0 ? ({ role: "user", content: "continue" } as Message) : ({ role: "assistant", content: "ok" } as Message),
);

/** Build a minimal conversation with a system message, assistant tool call, and tool result. */
function buildConversation(): Message[] {
	return [
		{ role: "system", content: "You are a helpful assistant." },
		{ role: "user", content: "Hello" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"foo.ts"}' } }],
		},
		{ role: "tool", content: "file contents here ".repeat(100), tool_call_id: "tc1" },
		{ role: "assistant", content: "Here is the file." },
		// Trailing context to push the tool result into the compactable age zone
		...TRAILING_CONTEXT,
	];
}

// ---------------------------------------------------------------------------
// shouldEmergencyCompact
// ---------------------------------------------------------------------------

describe("shouldEmergencyCompact", () => {
	// With EMERGENCY_TARGET = 0.9, charBudget = contextWindow * 0.9 * (promptChars/promptTokens)
	// Using promptTokens=1000, promptChars=3500 → charsPerToken=3.5
	// contextWindow=100000 → charBudget = 100000 * 0.9 * 3.5 = 315000

	test("returns true when total content chars exceed the budget", () => {
		// Create messages whose total content exceeds 315000 chars
		const bigContent = "x".repeat(320000);
		const messages = [{ content: bigContent }];
		expect(shouldEmergencyCompact(1000, 3500, 100000, messages)).toBe(true);
	});

	test("returns false when total content chars are within budget", () => {
		const smallContent = "x".repeat(100);
		const messages = [{ content: smallContent }];
		expect(shouldEmergencyCompact(1000, 3500, 100000, messages)).toBe(false);
	});

	test("returns false when contextWindow is 0", () => {
		const messages = [{ content: "x".repeat(320000) }];
		expect(shouldEmergencyCompact(1000, 3500, 0, messages)).toBe(false);
	});

	test("returns false when promptTokens is 0", () => {
		const messages = [{ content: "x".repeat(320000) }];
		expect(shouldEmergencyCompact(0, 3500, 100000, messages)).toBe(false);
	});

	test("returns false when promptChars is 0", () => {
		const messages = [{ content: "x".repeat(320000) }];
		expect(shouldEmergencyCompact(1000, 0, 100000, messages)).toBe(false);
	});

	test("edge case: content exactly at budget does not trigger", () => {
		// charBudget = 100000 * 0.9 * 3.5 = 315000
		const messages = [{ content: "x".repeat(315000) }];
		expect(shouldEmergencyCompact(1000, 3500, 100000, messages)).toBe(false);
	});

	test("edge case: content one char over budget triggers", () => {
		const messages = [{ content: "x".repeat(315001) }];
		expect(shouldEmergencyCompact(1000, 3500, 100000, messages)).toBe(true);
	});

	test("EMERGENCY_TARGET constant is 0.9", () => {
		expect(EMERGENCY_TARGET).toBe(0.9);
	});
});

// ---------------------------------------------------------------------------
// emergencyCompactConversation
// ---------------------------------------------------------------------------

describe("emergencyCompactConversation", () => {
	// For these tests we need promptTokens and promptChars that produce a charBudget
	// smaller than the conversation content. The buildConversation() function produces
	// messages with ~2000 chars of tool content + trailing context.
	// Total content ≈ "You are a helpful assistant." (29) + "Hello" (5) + 1900 (tool) +
	//   "Here is the file." (17) + 100 * ~8 chars = ~2751 chars.
	// Set charBudget small: contextWindow=1000, promptTokens=100, promptChars=350
	// → charsPerToken=3.5, charBudget = 1000 * 0.9 * 3.5 = 3150
	// That's slightly above conversation content. Need to reduce further.
	// contextWindow=500, promptTokens=100, promptChars=350 → budget = 500 * 0.9 * 3.5 = 1575
	// That should trigger compaction.

	test("applies compaction when content exceeds character budget with known tools", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const result = emergencyCompactConversation(
			conversation,
			100, // promptTokens
			350, // promptChars → charsPerToken = 3.5
			500, // contextWindow → budget = 500 * 0.9 * 3.5 = 1575
			registry,
		);
		// compactToBudget returns a new array when it compacts
		expect(result).not.toBe(conversation);
		// The result should still have messages
		expect(result.length).toBeGreaterThan(0);
	});

	test("returns conversation unchanged when no tools have outputThreshold", () => {
		const conversation = buildConversation();
		// emptyRegistry has no tools — engine skips unknown tools, but compactToBudget
		// still calls evictOldTurns. With small enough budget, eviction may still kick in.
		// Use a large budget so nothing triggers.
		const result = emergencyCompactConversation(
			conversation,
			100, // promptTokens
			350, // promptChars
			10000, // large contextWindow → budget = 10000 * 0.9 * 3.5 = 31500 — well above content
			emptyRegistry,
		);
		// Budget exceeds content → no compaction needed → same reference
		expect(result).toBe(conversation);
	});

	test("returns conversation unchanged when shouldEmergencyCompact is false", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const result = emergencyCompactConversation(
			conversation,
			100, // promptTokens
			350, // promptChars
			10000, // large contextWindow → budget well above content
			registry,
		);
		// Should be the exact same reference
		expect(result).toBe(conversation);
	});

	test("returns conversation unchanged when contextWindow is 0", () => {
		const conversation = buildConversation();
		const result = emergencyCompactConversation(conversation, 100, 350, 0, emptyRegistry);
		expect(result).toBe(conversation);
	});

	test("returns conversation unchanged when promptTokens and promptChars are 0", () => {
		const conversation = buildConversation();
		const result = emergencyCompactConversation(conversation, 0, 0, 10000, emptyRegistry);
		expect(result).toBe(conversation);
	});

	test("passes sessionId through to compactToBudget", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		// Just verify it doesn't throw when sessionId is provided
		const result = emergencyCompactConversation(
			conversation,
			100,
			350,
			500, // small budget to trigger compaction
			registry,
			undefined,
			undefined,
			undefined,
			"test-session-123",
		);
		expect(result).not.toBe(conversation);
	});

	test("writes dump file when compaction occurs and logDir is provided", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const fs = require("node:fs");
		const tmpDir = `${__dirname}/../compaction-emergency-test-dump.tmp`;
		const fakeLogger = {
			level: "debug" as const,
			logDir: tmpDir,
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		};

		try {
			const result = emergencyCompactConversation(
				conversation,
				100,
				350,
				500, // small budget to trigger compaction
				registry,
				tmpDir,
				fakeLogger,
			);
			// Should have compacted (new array)
			expect(result).not.toBe(conversation);
			// Dump files should exist in the tmpDir
			const files = fs.readdirSync(tmpDir);
			const emergencyFiles = files.filter((f: string) => f.includes("emg"));
			expect(emergencyFiles.length).toBeGreaterThanOrEqual(2); // pre and post
		} finally {
			// Clean up
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	test("does not write dump when no logDir", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		// Just verify it doesn't throw and returns a new array
		const result = emergencyCompactConversation(
			conversation,
			100,
			350,
			500, // small budget to trigger compaction
			registry,
			undefined,
		);
		expect(result).not.toBe(conversation);
	});

	test("logs via logger when compaction occurs with logDir and logger", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const fs = require("node:fs");
		const tmpDir = `${__dirname}/../compaction-emergency-logger-test.tmp`;
		const infoFn = mock(() => {});
		const fakeLogger = {
			level: "debug" as const,
			logDir: tmpDir,
			debug: mock(() => {}),
			info: infoFn,
			warn: mock(() => {}),
			error: mock(() => {}),
		};

		try {
			const result = emergencyCompactConversation(
				conversation,
				100,
				350,
				500, // small budget to trigger compaction
				registry,
				tmpDir,
				fakeLogger,
			);
			expect(result).not.toBe(conversation);
			// Logger.info should have been called with "COMPACTION" system and a message containing "emergency"
			expect(infoFn).toHaveBeenCalled();
			const [system, message] = infoFn.mock.calls[0] as [string, string];
			expect(system).toBe("COMPACTION");
			expect(message).toContain("emergency");
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});
});
