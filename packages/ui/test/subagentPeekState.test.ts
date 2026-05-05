import { describe, expect, test } from "bun:test";
import type { Message } from "../src/protocol";
import { buildDbPeekState, buildExitPeekState, buildLivePeekState } from "../src/subagentPeekState";

const parentMessages: Message[] = [
	{ role: "user", text: "Investigate the regression", timestamp: "2026-05-06 10:00:00" },
	{ role: "assistant", parts: [{ type: "text", content: "Working on it." }] },
];

describe("buildLivePeekState", () => {
	test("captures parent snapshot on first live peek and replays buffered child events", () => {
		const result = buildLivePeekState({
			childSessionId: "child-1",
			currentMessages: parentMessages,
			currentStatus: "parent status",
			storedParentMessages: [],
			storedParentStatus: "",
			bufferedEvents: [
				{ type: "prompt_echo", text: "Check logs", sessionId: "child-1" },
				{ type: "token", text: "Found the bug.", sessionId: "child-1" },
				{ type: "status", text: "child status", sessionId: "child-1" },
			],
		});

		expect(result.viewingSubagentId).toBe("child-1");
		expect(result.viewingSubagentTitle).toBeNull();
		expect(result.storedParentMessages).toEqual(parentMessages);
		expect(result.storedParentStatus).toBe("parent status");
		expect(result.displayedStatus).toBe("child status");
		expect(result.displayedMessages).toEqual([
			{
				role: "user",
				text: "Check logs",
				timestamp: result.displayedMessages[0]?.role === "user" ? result.displayedMessages[0].timestamp : "",
			},
			{ role: "assistant", parts: [{ type: "text", content: "Found the bug." }] },
		]);
	});

	test("preserves the original parent snapshot when switching between child peeks", () => {
		const originalParentSnapshot = [{ role: "assistant", parts: [{ type: "text", content: "Original parent" }] }] as Message[];
		const result = buildLivePeekState({
			childSessionId: "child-2",
			currentMessages: [{ role: "assistant", parts: [{ type: "text", content: "Current child view" }] }],
			currentStatus: "current child status",
			storedParentMessages: originalParentSnapshot,
			storedParentStatus: "original parent status",
			bufferedEvents: [{ type: "token", text: "Second child", sessionId: "child-2" }],
		});

		expect(result.storedParentMessages).toEqual(originalParentSnapshot);
		expect(result.storedParentStatus).toBe("original parent status");
		expect(result.displayedStatus).toBe("current child status");
		expect(result.displayedMessages).toEqual([{ role: "assistant", parts: [{ type: "text", content: "Second child" }] }]);
	});
});

describe("buildDbPeekState", () => {
	test("captures parent snapshot and reconstructs child messages from stored session data", () => {
		const result = buildDbPeekState({
			childSessionId: "child-1",
			currentMessages: parentMessages,
			currentStatus: "parent status",
			storedParentMessages: [],
			storedParentStatus: "",
			data: {
				session: { id: "child-1", title: "Inspect logs" },
				messages: [
					{
						id: "1",
						sessionId: "child-1",
						role: "user",
						content: "Show me the logs",
						createdAt: "2026-05-06T10:00:00Z",
						sortOrder: 1,
						metadata: null,
					},
					{
						id: "2",
						sessionId: "child-1",
						role: "assistant",
						content: "Found the stack trace",
						createdAt: "2026-05-06T10:00:01Z",
						sortOrder: 2,
						metadata: null,
					},
				],
				status: "loaded child status",
			},
		});

		expect(result.viewingSubagentId).toBe("child-1");
		expect(result.viewingSubagentTitle).toBe("Inspect logs");
		expect(result.storedParentMessages).toEqual(parentMessages);
		expect(result.storedParentStatus).toBe("parent status");
		expect(result.displayedStatus).toBe("loaded child status");
		expect(result.displayedMessages).toHaveLength(2);
		expect(result.displayedMessages[0]?.role).toBe("user");
		expect(result.displayedMessages[1]?.role).toBe("assistant");
	});

	test("falls back to the current status when stored child status is null", () => {
		const result = buildDbPeekState({
			childSessionId: "child-1",
			currentMessages: parentMessages,
			currentStatus: "parent status",
			storedParentMessages: [],
			storedParentStatus: "",
			data: {
				session: { id: "child-1", title: null },
				messages: [],
				status: null,
			},
		});

		expect(result.displayedStatus).toBe("parent status");
	});
});

describe("buildExitPeekState", () => {
	test("restores parent messages and clears peek state", () => {
		const result = buildExitPeekState({
			storedParentMessages: parentMessages,
			storedParentStatus: "parent status",
		});

		expect(result).toEqual({
			viewingSubagentId: null,
			viewingSubagentTitle: null,
			displayedMessages: parentMessages,
			displayedStatus: "parent status",
			storedParentMessages: [],
			storedParentStatus: "",
		});
	});
});
