import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { useWebSocket } from "../src/useWebSocket";
import { renderTestHook } from "./hookHelpers";

class MockWebSocket {
	static readonly OPEN = 1;
	static instances: MockWebSocket[] = [];

	readonly url: string;
	readyState = MockWebSocket.OPEN;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	sent: string[] = [];

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.onclose?.();
	}

	simulateOpen() {
		this.onopen?.();
	}

	simulateMessage(payload: unknown) {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	static reset() {
		MockWebSocket.instances = [];
	}
}

describe("useWebSocket integration", () => {
	const originalFetch = global.fetch;
	const originalWebSocket = global.WebSocket;
	const originalPushState = history.pushState;
	let fetchMock: ReturnType<typeof mock>;
	let pushStateMock: ReturnType<typeof mock>;

	beforeEach(() => {
		MockWebSocket.reset();
		fetchMock = mock().mockImplementation(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === "/bobai/project-info") {
				return { ok: false } as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as typeof fetch;
		global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		pushStateMock = mock();
		history.pushState = pushStateMock as typeof history.pushState;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		global.WebSocket = originalWebSocket;
		history.pushState = originalPushState;
	});

	test("session_created stores session id, clears volatile messages, and sends subscribe", async () => {
		const hook = await renderTestHook(() => useWebSocket());
		const socket = MockWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected WebSocket instance");
		}

		await act(async () => {
			hook.getValue().addVolatileMessage("temporary error", "error");
		});
		await act(async () => {
			socket.simulateMessage({ type: "session_created", sessionId: "s1" });
		});

		expect(hook.getValue().getSessionId()).toBe("s1");
		expect(hook.getValue().volatileMessages).toEqual([]);
		expect(pushStateMock).toHaveBeenCalledWith(null, "", "/bobai/s1");
		expect(socket.sent).toContain(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
		await hook.unmount();
	});

	test("session_locked and session_subscribed toggle lock state and clear the lock error", async () => {
		const hook = await renderTestHook(() => useWebSocket());
		const socket = MockWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected WebSocket instance");
		}

		await act(async () => {
			socket.simulateMessage({ type: "session_locked", sessionId: "s1" });
		});
		expect(hook.getValue().sessionLocked).toBe(true);
		expect(hook.getValue().volatileMessages).toEqual([{ text: "Session is active in another tab", kind: "error" }]);

		await act(async () => {
			socket.simulateMessage({ type: "session_subscribed", sessionId: "s1" });
		});
		expect(hook.getValue().sessionLocked).toBe(false);
		expect(hook.getValue().volatileMessages).toEqual([]);
		await hook.unmount();
	});

	test("sendPrompt followed by token and done builds the assistant message and stamps completion metadata", async () => {
		const hook = await renderTestHook(() => useWebSocket());
		const socket = MockWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected WebSocket instance");
		}

		await act(async () => {
			socket.simulateOpen();
		});
		expect(hook.getValue().connected).toBe(true);

		await act(async () => {
			hook.getValue().sendPrompt("Explain the failure");
		});
		expect(hook.getValue().isStreaming).toBe(true);
		expect(hook.getValue().messages[0]).toMatchObject({ role: "user", text: "Explain the failure" });
		expect(socket.sent).toContain(JSON.stringify({ type: "prompt", text: "Explain the failure" }));

		await act(async () => {
			socket.simulateMessage({ type: "token", text: "What I implemented\n\n#### New unified catalog\nI added:" });
		});
		await act(async () => {
			socket.simulateMessage({
				type: "done",
				sessionId: "s1",
				model: "gpt-4.1",
				title: "Loaded title",
				summary: "context: +12",
				provider: "openrouter",
			});
		});

		expect(hook.getValue().isStreaming).toBe(false);
		expect(hook.getValue().getSessionId()).toBe("s1");
		expect(hook.getValue().title).toBe("Loaded title");
		expect(hook.getValue().model).toBe("gpt-4.1");
		expect(hook.getValue().provider).toBe("openrouter");
		const assistant = hook.getValue().messages[1];
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.parts).toEqual([{ type: "text", content: "What I implemented\n\n#### New unified catalog\nI added:" }]);
			expect(assistant.model).toBe("gpt-4.1");
			expect(assistant.summary).toBe("context: +12");
			expect(assistant.timestamp).toBeTruthy();
		}
		await hook.unmount();
	});
});
