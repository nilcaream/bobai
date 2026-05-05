import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { createEventRouter } from "../src/eventRouter";
import { useSessionLoader } from "../src/hooks/useSessionLoader";
import type { Message } from "../src/protocol";
import { renderTestHook } from "./hookHelpers";

describe("useSessionLoader integration", () => {
	const originalFetch = global.fetch;
	const originalPushState = history.pushState;
	let fetchMock: ReturnType<typeof mock>;
	let pushStateMock: ReturnType<typeof mock>;

	beforeEach(() => {
		fetchMock = mock();
		global.fetch = fetchMock as typeof fetch;
		pushStateMock = mock();
		history.pushState = pushStateMock as typeof history.pushState;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		history.pushState = originalPushState;
	});

	function setupHook() {
		const state = {
			messages: [] as Message[],
			title: null as string | null,
			provider: null as string | null,
			model: null as string | null,
			parentId: null as string | null,
			parentTitle: null as string | null,
			subagents: [] as Array<{ sessionId: string; title: string; status: "running" | "done"; toolCallId: string }>,
			status: "",
			volatileMessages: [] as Array<{ text: string; kind: "error" | "success" | "info" }>,
			sessionLocked: false,
			welcomeMarkdown: "welcome" as string | null,
		};
		const sessionIdRef = { current: null as string | null };
		const parentMessagesRef = { current: [{ role: "assistant", parts: [{ type: "text", content: "Parent" }] }] as Message[] };
		const viewingSubagentIdRef = { current: null as string | null };
		const autoScrollRef = { current: false };
		const eventRouter = { current: createEventRouter() };
		const sendSubscribe = mock();
		const addVolatileMessage = (text: string, kind: "error" | "success" | "info") => {
			state.volatileMessages.push({ text, kind });
		};
		const clearVolatileMessages = () => {
			state.volatileMessages = [];
		};

		const hookPromise = renderTestHook(() =>
			useSessionLoader({
				sessionId: sessionIdRef,
				sendSubscribe,
				setMessages: (value) => {
					state.messages = typeof value === "function" ? value(state.messages) : value;
				},
				setTitle: (value) => {
					state.title = typeof value === "function" ? value(state.title) : value;
				},
				setProvider: (value) => {
					state.provider = typeof value === "function" ? value(state.provider) : value;
				},
				setModel: (value) => {
					state.model = typeof value === "function" ? value(state.model) : value;
				},
				setParentId: (value) => {
					state.parentId = typeof value === "function" ? value(state.parentId) : value;
				},
				setParentTitle: (value) => {
					state.parentTitle = typeof value === "function" ? value(state.parentTitle) : value;
				},
				setSubagents: (value) => {
					state.subagents = typeof value === "function" ? value(state.subagents) : value;
				},
				setStatus: (value) => {
					state.status = typeof value === "function" ? value(state.status) : value;
				},
				addVolatileMessage,
				clearVolatileMessages,
				setSessionLocked: (value) => {
					state.sessionLocked = typeof value === "function" ? value(state.sessionLocked) : value;
				},
				setWelcomeMarkdown: (value) => {
					state.welcomeMarkdown = typeof value === "function" ? value(state.welcomeMarkdown) : value;
				},
				viewingSubagentIdRef,
				setViewingSubagentId: (value) => {
					viewingSubagentIdRef.current = typeof value === "function" ? value(viewingSubagentIdRef.current) : value;
				},
				setViewingSubagentTitle: () => {},
				parentMessagesRef,
				eventRouter,
				autoScrollRef,
			}),
		);

		return { state, sessionIdRef, parentMessagesRef, viewingSubagentIdRef, autoScrollRef, sendSubscribe, hookPromise };
	}

	test("loadSession enters locked state when ownership check reports the session is owned", async () => {
		fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ owned: true }) });
		const { state, sessionIdRef, sendSubscribe, hookPromise } = setupHook();
		const hook = await hookPromise;

		let result = false;
		await act(async () => {
			result = await hook.getValue().loadSession("s1");
		});

		expect(result).toBe(true);
		expect(sessionIdRef.current).toBe("s1");
		expect(state.sessionLocked).toBe(true);
		expect(state.messages).toEqual([]);
		expect(state.volatileMessages).toEqual([{ text: "Session is active in another tab", kind: "error" }]);
		expect(pushStateMock).toHaveBeenCalledWith(null, "", "/bobai/s1");
		expect(sendSubscribe).toHaveBeenCalledWith("s1");
		await hook.unmount();
	});

	test("loadSession loads session data, resets state, and fetches parent title", async () => {
		fetchMock
			.mockResolvedValueOnce({ ok: true, json: async () => ({ owned: false }) })
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					session: { id: "s1", title: "Loaded chat", provider: "openrouter", model: "gpt-4.1", parentId: "parent-1" },
					messages: [
						{
							id: "1",
							sessionId: "s1",
							role: "assistant",
							content: "Loaded answer",
							createdAt: "2026-05-06T10:00:00Z",
							sortOrder: 1,
							metadata: null,
						},
					],
					status: "ready",
				}),
			})
			.mockResolvedValueOnce({ ok: true, json: async () => ({ session: { title: "Parent chat" } }) });

		const { state, sessionIdRef, autoScrollRef, sendSubscribe, hookPromise } = setupHook();
		const hook = await hookPromise;

		let result = false;
		await act(async () => {
			result = await hook.getValue().loadSession("s1");
		});

		expect(result).toBe(true);
		expect(sessionIdRef.current).toBe("s1");
		expect(state.title).toBe("Loaded chat");
		expect(state.provider).toBe("openrouter");
		expect(state.model).toBe("gpt-4.1");
		expect(state.parentId).toBe("parent-1");
		expect(state.parentTitle).toBe("Parent chat");
		expect(state.status).toBe("ready");
		expect(state.messages[0]?.role).toBe("assistant");
		expect(state.sessionLocked).toBe(false);
		expect(state.welcomeMarkdown).toBeNull();
		expect(autoScrollRef.current).toBe(true);
		expect(pushStateMock).toHaveBeenCalledWith(null, "", "/bobai/s1");
		expect(sendSubscribe).toHaveBeenCalledWith("s1");
		await hook.unmount();
	});
});
