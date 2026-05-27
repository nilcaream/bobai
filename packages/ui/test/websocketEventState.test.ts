import { describe, expect, test } from "bun:test";
import type { Message, ServerMessage, SubagentInfo } from "../src/protocol";
import { applyStreamingEvent, applySubagentLifecycle, stampStreamingCompletion } from "../src/websocketEventState";

describe("applyStreamingEvent", () => {
	test("prompt_echo followed by token builds user and assistant messages", () => {
		let messages: Message[] = [];
		messages = applyStreamingEvent(messages, { type: "prompt_echo", text: "Explain the bug" }, "2026-05-06 10:00:00");
		messages = applyStreamingEvent(messages, { type: "token", text: "I found it." }, "2026-05-06 10:00:01");

		expect(messages).toEqual([
			{ role: "user", text: "Explain the bug", timestamp: "2026-05-06 10:00:00" },
			{ role: "assistant", parts: [{ type: "text", content: "I found it." }] },
		]);
	});

	test("whitespace-only token between text tokens is preserved for markdown structure", () => {
		let messages: Message[] = [];
		messages = applyStreamingEvent(messages, { type: "token", text: "What I implemented" }, "2026-05-06 10:00:00");
		messages = applyStreamingEvent(messages, { type: "token", text: "\n\n" }, "2026-05-06 10:00:01");
		messages = applyStreamingEvent(
			messages,
			{ type: "token", text: "#### New unified catalog\nI added:" },
			"2026-05-06 10:00:02",
		);

		expect(messages).toEqual([
			{
				role: "assistant",
				parts: [{ type: "text", content: "What I implemented\n\n#### New unified catalog\nI added:" }],
			},
		]);
	});

	test("tool_call and tool_result are appended as assistant parts", () => {
		let messages: Message[] = [];
		messages = applyStreamingEvent(
			messages,
			{ type: "tool_call", id: "tc1", output: "▸ bash ls", mergeable: false },
			"2026-05-06 10:00:00",
		);
		messages = applyStreamingEvent(
			messages,
			{ type: "tool_result", id: "tc1", output: "file1\nfile2", mergeable: true, summary: "2 files" },
			"2026-05-06 10:00:01",
		);

		expect(messages).toEqual([
			{
				role: "assistant",
				parts: [
					{ type: "tool_call", id: "tc1", content: "▸ bash ls", mergeable: false },
					{ type: "tool_result", id: "tc1", content: "file1\nfile2", mergeable: true, summary: "2 files" },
				],
			},
		]);
	});

	test("reasoning_start creates a new reasoning part in the current assistant message", () => {
		let messages: Message[] = [{ role: "assistant", parts: [] }];
		messages = applyStreamingEvent(messages, { type: "reasoning_start" }, "2026-05-06 10:00:00");
		expect(messages).toEqual([{ role: "assistant", parts: [{ type: "reasoning", content: "" }] }]);
	});

	test("reasoning_start starts a second reasoning block when already in one", () => {
		let messages: Message[] = [{ role: "assistant", parts: [{ type: "reasoning", content: "first block" }] }];
		messages = applyStreamingEvent(messages, { type: "reasoning_start" }, "2026-05-06 10:00:01");
		expect(messages).toEqual([
			{
				role: "assistant",
				parts: [
					{ type: "reasoning", content: "first block" },
					{ type: "reasoning", content: "" },
				],
			},
		]);
	});

	test("reasoning_token appends to the last reasoning part", () => {
		let messages: Message[] = [{ role: "assistant", parts: [{ type: "reasoning", content: "Let me think" }] }];
		messages = applyStreamingEvent(messages, { type: "reasoning_token", text: " about this." }, "2026-05-06 10:00:01");
		expect(messages).toEqual([{ role: "assistant", parts: [{ type: "reasoning", content: "Let me think about this." }] }]);
	});

	test("reasoning_end removes empty reasoning parts", () => {
		const withContent: Message[] = [{ role: "assistant", parts: [{ type: "reasoning", content: "thinking complete" }] }];
		// Non-empty reasoning — no cleanup
		expect(applyStreamingEvent(withContent, { type: "reasoning_end" }, "")).toEqual(withContent);

		// Empty reasoning at end of parts — remove it
		const withEmpty: Message[] = [
			{
				role: "assistant",
				parts: [
					{ type: "text", content: "answer" },
					{ type: "reasoning", content: "" },
				],
			},
		];
		expect(applyStreamingEvent(withEmpty, { type: "reasoning_end" }, "")).toEqual([
			{ role: "assistant", parts: [{ type: "text", content: "answer" }] },
		]);

		// Only an empty reasoning part — remove the whole assistant if preceded by user
		const onlyEmpty: Message[] = [
			{ role: "user", text: "prompt", timestamp: "" },
			{ role: "assistant", parts: [{ type: "reasoning", content: "" }] },
		];
		expect(applyStreamingEvent(onlyEmpty, { type: "reasoning_end" }, "")).toEqual([
			{ role: "user", text: "prompt", timestamp: "" },
		]);

		// Empty reasoning followed by tool_call — reasoning not last part, must scan backward
		const emptyBeforeTool: Message[] = [
			{
				role: "assistant",
				parts: [
					{ type: "reasoning", content: "" },
					{ type: "tool_call", id: "t1", content: "output", mergeable: false },
				],
			},
		];
		expect(applyStreamingEvent(emptyBeforeTool, { type: "reasoning_end" }, "")).toEqual([
			{ role: "assistant", parts: [{ type: "tool_call", id: "t1", content: "output", mergeable: false }] },
		]);

		// Empty reasoning with tool_call and user preceding — reasoning removed, tool_call stays
		const emptyToolUser: Message[] = [
			{ role: "user", text: "prompt", timestamp: "" },
			{
				role: "assistant",
				parts: [
					{ type: "reasoning", content: "" },
					{ type: "tool_call", id: "t1", content: "output", mergeable: false },
				],
			},
		];
		expect(applyStreamingEvent(emptyToolUser, { type: "reasoning_end" }, "")).toEqual([
			{ role: "user", text: "prompt", timestamp: "" },
			{ role: "assistant", parts: [{ type: "tool_call", id: "t1", content: "output", mergeable: false }] },
		]);
	});

	test("reasoning tokens stream interleaved with text tokens", () => {
		let messages: Message[] = [];
		messages = applyStreamingEvent(messages, { type: "reasoning_start" }, "2026-05-06 10:00:00");
		messages = applyStreamingEvent(messages, { type: "reasoning_token", text: "hmm" }, "2026-05-06 10:00:01");
		messages = applyStreamingEvent(messages, { type: "reasoning_end" }, "2026-05-06 10:00:02");
		messages = applyStreamingEvent(messages, { type: "token", text: "Answer." }, "2026-05-06 10:00:03");

		expect(messages).toEqual([
			{
				role: "assistant",
				parts: [
					{ type: "reasoning", content: "hmm" },
					{ type: "text", content: "Answer." },
				],
			},
		]);
	});

	test("error event is converted into assistant text part", () => {
		const messages = applyStreamingEvent([], { type: "error", message: "Oops" }, "2026-05-06 10:00:00");
		expect(messages).toEqual([{ role: "assistant", parts: [{ type: "text", content: "Error: Oops" }] }]);
	});

	test("status and unrelated lifecycle events do not mutate messages", () => {
		const initial: Message[] = [{ role: "assistant", parts: [{ type: "text", content: "Existing" }] }];
		const statusResult = applyStreamingEvent(initial, { type: "status", text: "thinking" }, "2026-05-06 10:00:00");
		const doneResult = applyStreamingEvent(
			initial,
			{ type: "done", sessionId: "sid-1", model: "gpt-4.1", summary: "done" },
			"2026-05-06 10:00:01",
		);

		expect(statusResult).toEqual(initial);
		expect(doneResult).toEqual(initial);
	});
});

describe("stampStreamingCompletion", () => {
	test("stamps the last assistant message with timestamp, model, and summary", () => {
		const initial: Message[] = [{ role: "assistant", parts: [{ type: "text", content: "Done." }] }];
		const result = stampStreamingCompletion(
			initial,
			{ type: "done", sessionId: "sid-1", model: "gpt-4.1", summary: "context: +12" },
			"2026-05-06 10:01:00",
		);
		expect(result).toEqual([
			{
				role: "assistant",
				parts: [{ type: "text", content: "Done." }],
				timestamp: "2026-05-06 10:01:00",
				model: "gpt-4.1",
				summary: "context: +12",
			},
		]);
	});

	test("leaves messages unchanged when the last message is not assistant", () => {
		const initial: Message[] = [{ role: "user", text: "Hello", timestamp: "2026-05-06 10:00:00" }];
		const result = stampStreamingCompletion(
			initial,
			{ type: "done", sessionId: "sid-1", model: "gpt-4.1" },
			"2026-05-06 10:01:00",
		);
		expect(result).toEqual(initial);
	});
});

describe("applySubagentLifecycle", () => {
	test("subagent_start appends a running subagent entry", () => {
		const result = applySubagentLifecycle([], {
			type: "subagent_start",
			sessionId: "child-1",
			title: "Inspect logs",
			toolCallId: "tc1",
		});

		expect(result).toEqual([{ sessionId: "child-1", title: "Inspect logs", status: "running", toolCallId: "tc1" }]);
	});

	test("subagent_done marks the matching subagent as done", () => {
		const initial: SubagentInfo[] = [
			{ sessionId: "child-1", title: "Inspect logs", status: "running", toolCallId: "tc1" },
			{ sessionId: "child-2", title: "Trace bug", status: "running", toolCallId: "tc2" },
		];
		const result = applySubagentLifecycle(initial, { type: "subagent_done", sessionId: "child-2", model: "gpt-4.1" });

		expect(result).toEqual([
			{ sessionId: "child-1", title: "Inspect logs", status: "running", toolCallId: "tc1" },
			{ sessionId: "child-2", title: "Trace bug", status: "done", toolCallId: "tc2" },
		]);
	});

	test("non-lifecycle messages leave subagents unchanged", () => {
		const initial: SubagentInfo[] = [{ sessionId: "child-1", title: "Inspect logs", status: "running", toolCallId: "tc1" }];
		const msg: ServerMessage = { type: "token", text: "hello" };
		expect(applySubagentLifecycle(initial, msg)).toEqual(initial);
	});
});
