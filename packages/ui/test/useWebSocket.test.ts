import { describe, expect, test } from "bun:test";
import type { VolatileMessage } from "../src/protocol";
import { filterVolatileMessagesOnSessionSubscribed, shouldSubscribeToSession } from "../src/useWebSocket";

describe("useWebSocket helpers", () => {
	test("shouldSubscribeToSession returns false when subscribing to the already active session", () => {
		expect(shouldSubscribeToSession("sid-1", "sid-1")).toBe(false);
	});

	test("shouldSubscribeToSession returns true when switching sessions or attaching to a new one", () => {
		expect(shouldSubscribeToSession(null, "sid-1")).toBe(true);
		expect(shouldSubscribeToSession("sid-1", "sid-2")).toBe(true);
	});

	test("filterVolatileMessagesOnSessionSubscribed removes only the session-lock error", () => {
		const messages: VolatileMessage[] = [
			{ text: "Session is active in another tab", kind: "error" },
			{ text: "Using openrouter openrouter/free model", kind: "info" },
			{ text: "Another error", kind: "error" },
		];

		expect(filterVolatileMessagesOnSessionSubscribed(messages)).toEqual([
			{ text: "Using openrouter openrouter/free model", kind: "info" },
			{ text: "Another error", kind: "error" },
		]);
	});
});
