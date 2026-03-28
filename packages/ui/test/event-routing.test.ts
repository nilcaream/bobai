import { describe, expect, test } from "bun:test";
import { createEventRouter } from "../src/eventRouter";

describe("event routing", () => {
	test("parent events (no sessionId) are routed to parent", () => {
		const router = createEventRouter();
		const result = router.route({ type: "token", text: "hello" });
		expect(result).toEqual({ target: "parent", msg: { type: "token", text: "hello" } });
	});

	test("child events are buffered by sessionId", () => {
		const router = createEventRouter();
		router.route({ type: "token", text: "child text", sessionId: "child-1" });
		const buffer = router.getBuffer("child-1");
		expect(buffer).toHaveLength(1);
		expect(buffer[0]).toEqual({ type: "token", text: "child text", sessionId: "child-1" });
	});

	test("child events are NOT routed to parent", () => {
		const router = createEventRouter();
		const result = router.route({ type: "token", text: "child text", sessionId: "child-1" });
		expect(result).toEqual({ target: "child", sessionId: "child-1" });
	});

	test("done message is always routed to parent", () => {
		const router = createEventRouter();
		const result = router.route({ type: "done", sessionId: "parent-1", model: "gpt-5" });
		expect(result).toEqual({ target: "parent", msg: expect.objectContaining({ type: "done" }) });
	});

	test("subagent_start and subagent_done are routed to lifecycle handler", () => {
		const router = createEventRouter();
		const r1 = router.route({ type: "subagent_start", sessionId: "child-1", title: "Task", toolCallId: "call_1" });
		expect(r1).toEqual({ target: "lifecycle", msg: expect.objectContaining({ type: "subagent_start" }) });
		const r2 = router.route({ type: "subagent_done", sessionId: "child-1" });
		expect(r2).toEqual({ target: "lifecycle", msg: expect.objectContaining({ type: "subagent_done" }) });
	});

	test("multiple children buffer independently", () => {
		const router = createEventRouter();
		router.route({ type: "token", text: "a", sessionId: "child-1" });
		router.route({ type: "token", text: "b", sessionId: "child-2" });
		router.route({ type: "token", text: "c", sessionId: "child-1" });
		expect(router.getBuffer("child-1")).toHaveLength(2);
		expect(router.getBuffer("child-2")).toHaveLength(1);
	});

	test("clearBuffer removes buffered events for a session", () => {
		const router = createEventRouter();
		router.route({ type: "token", text: "a", sessionId: "child-1" });
		router.clearBuffer("child-1");
		expect(router.getBuffer("child-1")).toHaveLength(0);
	});

	test("clearAllBuffers removes all child buffers", () => {
		const router = createEventRouter();
		router.route({ type: "token", text: "a", sessionId: "child-1" });
		router.route({ type: "token", text: "b", sessionId: "child-2" });
		router.clearAllBuffers();
		expect(router.getBuffer("child-1")).toHaveLength(0);
		expect(router.getBuffer("child-2")).toHaveLength(0);
	});

	test("session management events route to parent", () => {
		const router = createEventRouter();
		const r1 = router.route({ type: "session_created", sessionId: "s1" });
		expect(r1.target).toBe("parent");
		const r2 = router.route({ type: "session_subscribed", sessionId: "s1" });
		expect(r2.target).toBe("parent");
		const r3 = router.route({ type: "session_locked", sessionId: "s1" });
		expect(r3.target).toBe("parent");
	});

	test("prompt_echo routes to parent", () => {
		const router = createEventRouter();
		const result = router.route({ type: "prompt_echo", text: "hello" });
		expect(result.target).toBe("parent");
	});

	test("error with sessionId is buffered as child event", () => {
		const router = createEventRouter();
		const result = router.route({ type: "error", message: "oops", sessionId: "child-1" });
		expect(result).toEqual({ target: "child", sessionId: "child-1" });
		expect(router.getBuffer("child-1")).toHaveLength(1);
	});

	test("error without sessionId routes to parent", () => {
		const router = createEventRouter();
		const result = router.route({ type: "error", message: "oops" });
		expect(result.target).toBe("parent");
	});

	test("tool_call with sessionId is buffered", () => {
		const router = createEventRouter();
		const result = router.route({ type: "tool_call", id: "tc1", output: "▸ read_file", sessionId: "child-1" });
		expect(result).toEqual({ target: "child", sessionId: "child-1" });
		expect(router.getBuffer("child-1")).toHaveLength(1);
	});

	test("tool_result with sessionId is buffered", () => {
		const router = createEventRouter();
		const result = router.route({ type: "tool_result", id: "tc1", output: "contents", mergeable: true, sessionId: "child-1" });
		expect(result).toEqual({ target: "child", sessionId: "child-1" });
	});

	test("status with sessionId is buffered", () => {
		const router = createEventRouter();
		const result = router.route({ type: "status", text: "thinking", sessionId: "child-1" });
		expect(result).toEqual({ target: "child", sessionId: "child-1" });
	});

	test("getBuffer returns empty array for unknown sessionId", () => {
		const router = createEventRouter();
		expect(router.getBuffer("nonexistent")).toEqual([]);
	});
});
