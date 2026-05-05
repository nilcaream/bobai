import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { createEventRouter } from "../src/eventRouter";
import { useSubagentPeek } from "../src/hooks/useSubagentPeek";
import type { Message } from "../src/protocol";
import { renderTestHook } from "./hookHelpers";

describe("useSubagentPeek integration", () => {
	const originalFetch = global.fetch;
	let fetchMock: ReturnType<typeof mock>;

	beforeEach(() => {
		fetchMock = mock();
		global.fetch = fetchMock as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	test("peekSubagent replays buffered child events into displayed messages and status", async () => {
		const messagesRef = { current: [{ role: "assistant", parts: [{ type: "text", content: "Parent" }] }] as Message[] };
		let displayedMessages = messagesRef.current;
		let displayedStatus = "parent status";
		const setMessages = (value: React.SetStateAction<Message[]>) => {
			displayedMessages = typeof value === "function" ? value(displayedMessages) : value;
		};
		const setStatus = (value: React.SetStateAction<string>) => {
			displayedStatus = typeof value === "function" ? value(displayedStatus) : value;
		};
		const routerRef = { current: createEventRouter() };
		routerRef.current.route({ type: "prompt_echo", text: "Inspect child", sessionId: "child-1" });
		routerRef.current.route({ type: "token", text: "Found it.", sessionId: "child-1" });
		routerRef.current.route({ type: "status", text: "child status", sessionId: "child-1" });

		const hook = await renderTestHook(() => useSubagentPeek(messagesRef, setMessages, displayedStatus, setStatus, routerRef));

		await act(async () => {
			hook.getValue().peekSubagent("child-1");
		});

		expect(hook.getValue().viewingSubagentId).toBe("child-1");
		expect(displayedStatus).toBe("child status");
		expect(displayedMessages).toHaveLength(2);
		expect(displayedMessages[0]?.role).toBe("user");
		if (displayedMessages[0]?.role === "user") {
			expect(displayedMessages[0].text).toBe("Inspect child");
		}
		expect(displayedMessages[1]).toEqual({ role: "assistant", parts: [{ type: "text", content: "Found it." }] });
		await hook.unmount();
	});

	test("exitSubagentPeek restores parent messages and status", async () => {
		const parentMessages: Message[] = [{ role: "assistant", parts: [{ type: "text", content: "Parent" }] }];
		const messagesRef = { current: parentMessages };
		let displayedMessages = parentMessages;
		let displayedStatus = "parent status";
		const setMessages = (value: React.SetStateAction<Message[]>) => {
			displayedMessages = typeof value === "function" ? value(displayedMessages) : value;
		};
		const setStatus = (value: React.SetStateAction<string>) => {
			displayedStatus = typeof value === "function" ? value(displayedStatus) : value;
		};
		const routerRef = { current: createEventRouter() };
		routerRef.current.route({ type: "token", text: "Child", sessionId: "child-1" });

		const hook = await renderTestHook(() => useSubagentPeek(messagesRef, setMessages, displayedStatus, setStatus, routerRef));

		await act(async () => {
			hook.getValue().peekSubagent("child-1");
		});
		await act(async () => {
			hook.getValue().exitSubagentPeek();
		});

		expect(hook.getValue().viewingSubagentId).toBeNull();
		expect(displayedMessages).toEqual(parentMessages);
		expect(displayedStatus).toBe("parent status");
		await hook.unmount();
	});

	test("peekSubagentFromDb loads child session and updates title", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				session: { id: "child-1", title: "Inspect child" },
				messages: [
					{
						id: "1",
						sessionId: "child-1",
						role: "assistant",
						content: "Loaded from DB",
						createdAt: "2026-05-06T10:00:00Z",
						sortOrder: 1,
						metadata: null,
					},
				],
				status: "db status",
			}),
		});

		const messagesRef = { current: [{ role: "assistant", parts: [{ type: "text", content: "Parent" }] }] as Message[] };
		let displayedMessages = messagesRef.current;
		let displayedStatus = "parent status";
		const setMessages = (value: React.SetStateAction<Message[]>) => {
			displayedMessages = typeof value === "function" ? value(displayedMessages) : value;
		};
		const setStatus = (value: React.SetStateAction<string>) => {
			displayedStatus = typeof value === "function" ? value(displayedStatus) : value;
		};
		const routerRef = { current: createEventRouter() };

		const hook = await renderTestHook(() => useSubagentPeek(messagesRef, setMessages, displayedStatus, setStatus, routerRef));

		await act(async () => {
			await hook.getValue().peekSubagentFromDb("child-1");
		});

		expect(fetchMock).toHaveBeenCalledWith("/bobai/session/child-1/load");
		expect(hook.getValue().viewingSubagentId).toBe("child-1");
		expect(hook.getValue().viewingSubagentTitle).toBe("Inspect child");
		expect(displayedStatus).toBe("db status");
		expect(displayedMessages[0]?.role).toBe("assistant");
		await hook.unmount();
	});
});
