import { describe, expect, mock, test } from "bun:test";
import { EMERGENCY_THRESHOLD, emergencyCompactConversation, shouldEmergencyCompact } from "../src/agent-loop";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
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
	test("returns true when promptTokens/contextWindow >= 0.85", () => {
		expect(shouldEmergencyCompact(8500, 10000)).toBe(true);
		expect(shouldEmergencyCompact(9000, 10000)).toBe(true);
		expect(shouldEmergencyCompact(10000, 10000)).toBe(true);
	});

	test("returns false when below 0.85", () => {
		expect(shouldEmergencyCompact(8499, 10000)).toBe(false);
		expect(shouldEmergencyCompact(5000, 10000)).toBe(false);
		expect(shouldEmergencyCompact(1, 10000)).toBe(false);
	});

	test("returns false when contextWindow is 0", () => {
		expect(shouldEmergencyCompact(1000, 0)).toBe(false);
	});

	test("returns false when promptTokens is 0", () => {
		expect(shouldEmergencyCompact(0, 10000)).toBe(false);
	});

	test("edge case: exactly at 0.85", () => {
		// 85% of 10000 is 8500 — should trigger
		expect(shouldEmergencyCompact(8500, 10000)).toBe(true);
		// 85% of 20000 is 17000
		expect(shouldEmergencyCompact(17000, 20000)).toBe(true);
	});

	test("threshold constant is 0.85", () => {
		expect(EMERGENCY_THRESHOLD).toBe(0.85);
	});
});

// ---------------------------------------------------------------------------
// emergencyCompactConversation
// ---------------------------------------------------------------------------

describe("emergencyCompactConversation", () => {
	test("applies compaction when above 85% with known tools", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const result = emergencyCompactConversation(
			conversation,
			9000, // 90% of 10000
			10000,
			registry,
		);
		// compactMessages returns a new array when it compacts
		// At 90% usage, the read_file output should exceed its outputThreshold
		expect(result).not.toBe(conversation);
		// The result should still have the same number of messages (compaction changes content, not count)
		expect(result.length).toBe(conversation.length);
	});

	test("returns conversation unchanged when no tools have outputThreshold", () => {
		const conversation = buildConversation();
		// emptyRegistry has no tools — engine skips unknown tools
		const result = emergencyCompactConversation(
			conversation,
			9000, // 90% of 10000
			10000,
			emptyRegistry,
		);
		// No registered tools → nothing to compact → same reference
		expect(result).toBe(conversation);
	});

	test("returns conversation unchanged when shouldEmergencyCompact is false", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		const result = emergencyCompactConversation(
			conversation,
			5000, // 50% — well below 85%
			10000,
			registry,
		);
		// Should be the exact same reference
		expect(result).toBe(conversation);
	});

	test("returns conversation unchanged when contextWindow is 0", () => {
		const conversation = buildConversation();
		const result = emergencyCompactConversation(conversation, 9000, 0, emptyRegistry);
		expect(result).toBe(conversation);
	});

	test("passes sessionId through to compactMessages", () => {
		const conversation = buildConversation();
		const registry = createReadFileRegistry();
		// Just verify it doesn't throw when sessionId is provided
		const result = emergencyCompactConversation(
			conversation,
			9000,
			10000,
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
			const result = emergencyCompactConversation(conversation, 9000, 10000, registry, tmpDir, fakeLogger);
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
		const result = emergencyCompactConversation(conversation, 9000, 10000, registry, undefined);
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
			const result = emergencyCompactConversation(conversation, 9000, 10000, registry, tmpDir, fakeLogger);
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
