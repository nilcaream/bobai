import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../src/messageReconstruction";
import { applyLoadedSessionState, createLockedSessionState } from "../src/sessionLoaderState";

const storedMessages: StoredMessage[] = [
	{
		id: "1",
		sessionId: "s1",
		role: "user",
		content: "Hello",
		createdAt: "2026-05-06T10:00:00Z",
		sortOrder: 1,
		metadata: null,
	},
	{
		id: "2",
		sessionId: "s1",
		role: "assistant",
		content: "Hi there",
		createdAt: "2026-05-06T10:00:01Z",
		sortOrder: 2,
		metadata: null,
	},
];

describe("createLockedSessionState", () => {
	test("creates a locked session state with cleared messages", () => {
		const result = createLockedSessionState("s1");
		expect(result).toEqual({
			sessionId: "s1",
			sessionLocked: true,
			messages: [],
			volatileMessage: { text: "Session is active in another tab", kind: "error" },
		});
	});
});

describe("applyLoadedSessionState", () => {
	test("maps loaded session payload into UI state", () => {
		const result = applyLoadedSessionState({
			session: { id: "s1", title: "Chat", provider: "openrouter", model: "gpt-4.1", parentId: "parent-1" },
			messages: storedMessages,
			status: "ready",
		});

		expect(result.sessionId).toBe("s1");
		expect(result.title).toBe("Chat");
		expect(result.provider).toBe("openrouter");
		expect(result.model).toBe("gpt-4.1");
		expect(result.parentId).toBe("parent-1");
		expect(result.subagents).toEqual([]);
		expect(result.status).toBe("ready");
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]?.role).toBe("user");
		expect(result.messages[1]?.role).toBe("assistant");
	});

	test("normalizes null status to an empty string", () => {
		const result = applyLoadedSessionState({
			session: { id: "s1", title: null, provider: null, model: null, parentId: null },
			messages: [],
			status: null,
		});

		expect(result.status).toBe("");
		expect(result.title).toBeNull();
		expect(result.provider).toBeNull();
		expect(result.model).toBeNull();
		expect(result.parentId).toBeNull();
	});
});
