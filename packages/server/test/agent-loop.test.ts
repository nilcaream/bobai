import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../src/agent-loop";
import { runAgentLoop } from "../src/agent-loop";
import type {
	AssistantMessage,
	InterleavedChatReasoningState,
	Message,
	Provider,
	ProviderOptions,
	ReasoningDelta,
	ResponsesItemReasoningState,
	StreamEvent,
	ToolMessage,
} from "../src/provider/provider";
import { appendMessage, createSession, getMessages } from "../src/session/repository";
import { editFileTool } from "../src/tool/edit-file";
import { readFileTool } from "../src/tool/read-file";
import type { Tool, ToolResult } from "../src/tool/tool";
import { createToolRegistry } from "../src/tool/tool";
import { createTestDb } from "./helpers";
import { createProviderModelsTempDir } from "./test-provider-models";

function textProvider(tokens: string[]): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			for (const t of tokens) yield { type: "text", text: t };
			yield { type: "finish", reason: "stop" };
		},
	};
}

/** Provider that returns tool_calls on the first call and text on the second */
function toolThenTextProvider(toolCallId: string, toolName: string, toolArgs: string, secondResponse: string[]): Provider {
	let callCount = 0;
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			if (callCount === 1) {
				yield { type: "tool_call_start", index: 0, id: toolCallId, name: toolName };
				yield { type: "tool_call_delta", index: 0, arguments: toolArgs };
				yield { type: "finish", reason: "tool_calls" };
			} else {
				for (const t of secondResponse) yield { type: "text", text: t };
				yield { type: "finish", reason: "stop" };
			}
		},
	};
}

function echoTool(): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: "echo",
				description: "Echo the input",
				parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
		},
		mergeable: true,
		formatCall(args: Record<string, unknown>): string {
			return `▸ Echo ${args.text}`;
		},
		async execute(args: Record<string, unknown>): Promise<ToolResult> {
			return { llmOutput: `echoed: ${args.text}`, uiOutput: `▸ Echo ${args.text} (done)`, mergeable: true };
		},
	};
}

describe("provider reasoning types", () => {
	test("assistant messages can carry optional reasoning state", () => {
		const responsesReasoning: ResponsesItemReasoningState = {
			kind: "responses-item",
			id: "rs_1",
			summary: "condensed",
			encryptedContent: "opaque",
		};
		const chatReasoning: InterleavedChatReasoningState = {
			kind: "interleaved-chat",
			field: "reasoning_content",
			text: "step 1",
		};
		const assistantWithReasoning: AssistantMessage = {
			role: "assistant",
			content: "Answer",
			reasoning: [responsesReasoning, chatReasoning, { kind: "text-summary", text: "portable summary" }],
		};

		expect(assistantWithReasoning.reasoning).toHaveLength(3);
	});

	test("provider stream consumers can accept reasoning stream events", async () => {
		const firstReasoning: InterleavedChatReasoningState = {
			kind: "interleaved-chat",
			field: "reasoning_content",
			text: "first thought",
		};
		const delta: ReasoningDelta = {
			kind: "text",
			text: " continued",
		};
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield {
					type: "reasoning_start",
					index: 0,
					reasoning: firstReasoning,
				};
				yield { type: "reasoning_delta", index: 0, delta };
				yield { type: "reasoning_end", index: 0, reasoning: { kind: "text-summary", text: "done thinking" } };
				yield { type: "text", text: "Answer" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const seen: StreamEvent[] = [];
		for await (const event of provider.stream({ model: "test", messages: [] })) {
			seen.push(event);
		}

		expect(seen).toHaveLength(5);
		expect(seen[0]).toEqual({ type: "reasoning_start", index: 0, reasoning: firstReasoning });
		expect(seen[1]).toEqual({ type: "reasoning_delta", index: 0, delta });
	});

	test("runAgentLoop attaches accumulated reasoning to text-only assistant messages", async () => {
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop({
			provider: {
				id: "mock",
				async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
					yield {
						type: "reasoning_start",
						index: 0,
						reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "thinking" },
					};
					yield {
						type: "reasoning_delta",
						index: 0,
						delta: { kind: "text", text: " harder" },
					};
					yield { type: "text", text: "Hello" };
					yield { type: "reasoning_end", index: 0, reasoning: { kind: "text-summary", text: "done" } };
					yield { type: "text", text: " world" };
					yield { type: "finish", reason: "stop" };
				},
			},
			model: "test",
			messages: [{ role: "user", content: "hi" }],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		expect(events).toEqual([
			{ type: "reasoning_start" },
			{ type: "reasoning_token", text: " harder" },
			{ type: "text", text: "Hello" },
			{ type: "reasoning_end" },
			{ type: "text", text: " world" },
		]);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: "Hello world",
				reasoning: [
					{ kind: "interleaved-chat", field: "reasoning_content", text: "thinking harder" },
					{ kind: "text-summary", text: "done" },
				],
			},
		]);
	});

	test("runAgentLoop attaches accumulated reasoning to assistant tool-call messages", async () => {
		const events: AgentEvent[] = [];
		const seenMessages: Message[] = [];
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "reasoning_start",
						index: 0,
						reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "thinking" },
					};
					yield {
						type: "reasoning_delta",
						index: 0,
						delta: { kind: "text", text: " about tool" },
					};
					yield { type: "tool_call_start", index: 0, id: "call-1", name: "echo" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"text":"hi"}' };
					yield { type: "reasoning_end", index: 0, reasoning: { kind: "text-summary", text: "done" } };
					yield { type: "finish", reason: "tool_calls" };
					return;
				}
				yield { type: "finish", reason: "stop" };
			},
		};

		const newMessages = await runAgentLoop({
			provider,
			model: "test",
			messages: [{ role: "user", content: "hi" }],
			tools: createToolRegistry([echoTool()]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(event) {
				events.push(event);
			},
			onMessage(message) {
				seenMessages.push(message);
			},
			maxIterations: 1,
		});

		expect(events).toEqual([
			{ type: "reasoning_start" },
			{ type: "reasoning_token", text: " about tool" },
			{ type: "reasoning_end" },
			{ type: "tool_call", id: "call-1", output: "▸ Echo hi", mergeable: true },
			{
				type: "tool_result",
				id: "call-1",
				output: "▸ Echo hi (done)",
				mergeable: true,
				summary: undefined,
				metadata: undefined,
			},
		]);
		expect(seenMessages[0]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
			reasoning: [
				{ kind: "interleaved-chat", field: "reasoning_content", text: "thinking about tool" },
				{ kind: "text-summary", text: "done" },
			],
		});
		expect(seenMessages[1]).toEqual({ role: "tool", content: "echoed: hi", tool_call_id: "call-1" });
		expect(newMessages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
				reasoning: [
					{ kind: "interleaved-chat", field: "reasoning_content", text: "thinking about tool" },
					{ kind: "text-summary", text: "done" },
				],
			},
			{ role: "tool", content: "echoed: hi", tool_call_id: "call-1" },
			{ role: "assistant", content: "" },
		]);
	});

	test("runAgentLoop merges same-kind final reasoning and orders multiple indexes stably", async () => {
		const messages = await runAgentLoop({
			provider: {
				id: "mock",
				async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
					yield {
						type: "reasoning_start",
						index: 1,
						reasoning: { kind: "responses-item", id: "rs_2" },
					};
					yield {
						type: "reasoning_start",
						index: 0,
						reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "A" },
					};
					yield { type: "reasoning_delta", index: 1, delta: { kind: "summary", summary: "sum-2" } };
					yield { type: "reasoning_delta", index: 1, delta: { kind: "encrypted-content", encryptedContent: "enc-2" } };
					yield { type: "reasoning_delta", index: 0, delta: { kind: "details", details: { step: 1 } } };
					yield {
						type: "reasoning_end",
						index: 1,
						reasoning: { kind: "responses-item", id: "rs_2-final", summary: "sum-2-final" },
					};
					yield {
						type: "reasoning_end",
						index: 2,
						reasoning: { kind: "text-summary", text: "orphan" },
					};
					yield { type: "text", text: "Done" };
					yield { type: "finish", reason: "stop" };
				},
			},
			model: "test",
			messages: [{ role: "user", content: "hi" }],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent() {},
			onMessage() {},
		});

		expect(messages).toEqual([
			{
				role: "assistant",
				content: "Done",
				reasoning: [
					{ kind: "interleaved-chat", field: "reasoning_content", text: "A", details: { step: 1 } },
					{ kind: "responses-item", id: "rs_2-final", summary: "sum-2-final", encryptedContent: "enc-2" },
					{ kind: "text-summary", text: "orphan" },
				],
			},
		]);
	});

	test("final fallback call preserves accumulated reasoning after maxIterations is reached", async () => {
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "echo" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"text":"loop"}' };
					yield { type: "finish", reason: "tool_calls" };
					return;
				}
				yield {
					type: "reasoning_start",
					index: 0,
					reasoning: { kind: "responses-item", id: "rs_final" },
				};
				yield { type: "reasoning_delta", index: 0, delta: { kind: "summary", summary: "final-summary" } };
				yield {
					type: "reasoning_end",
					index: 0,
					reasoning: { kind: "responses-item", id: "rs_final_done", encryptedContent: "enc-final" },
				};
				yield { type: "text", text: "Recovered" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const messages = await runAgentLoop({
			provider,
			model: "test",
			messages: [{ role: "user", content: "loop" }],
			tools: createToolRegistry([echoTool()]),
			projectRoot: "/tmp",
			maxIterations: 1,
			onEvent() {},
			onMessage() {},
		});

		expect(messages.at(-1)).toEqual({
			role: "assistant",
			content: "Recovered",
			reasoning: [{ kind: "responses-item", id: "rs_final_done", summary: "final-summary", encryptedContent: "enc-final" }],
		});
	});

	test("assistant reasoning metadata survives persistence when stored from emitted messages", async () => {
		const db = createTestDb();
		const session = createSession(db);

		await runAgentLoop({
			provider: {
				id: "mock",
				async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
					yield {
						type: "reasoning_start",
						index: 0,
						reasoning: { kind: "interleaved-chat", field: "reasoning_content", text: "thinking" },
					};
					yield {
						type: "reasoning_delta",
						index: 0,
						delta: { kind: "text", text: " harder" },
					};
					yield { type: "reasoning_end", index: 0, reasoning: { kind: "text-summary", text: "done" } };
					yield { type: "text", text: "Answer" };
					yield { type: "finish", reason: "stop" };
				},
			},
			model: "test",
			messages: [{ role: "user", content: "hi" }],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			sessionId: session.id,
			onEvent() {},
			onMessage(msg) {
				if (msg.role !== "assistant") return;
				const metadata = {
					...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
					...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
				};
				appendMessage(db, session.id, "assistant", msg.content ?? "", Object.keys(metadata).length > 0 ? metadata : undefined);
			},
		});

		const storedMessages = getMessages(db, session.id);
		expect(storedMessages).toHaveLength(1);
		expect(storedMessages[0]?.metadata).toEqual({
			reasoning: [
				{ kind: "interleaved-chat", field: "reasoning_content", text: "thinking harder" },
				{ kind: "text-summary", text: "done" },
			],
		});

		db.close();
	});
});

describe("runAgentLoop", () => {
	test("returns text response when no tool calls", async () => {
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop({
			provider: textProvider(["Hello", " world"]),
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		// Should return the assistant message
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		expect((messages[0] as { content: string }).content).toBe("Hello world");

		// Should have emitted text events
		const textEvents = events.filter((e) => e.type === "text");
		expect(textEvents).toHaveLength(2);
	});

	test("executes tool calls and loops back to provider", async () => {
		const events: AgentEvent[] = [];
		const registry = createToolRegistry([echoTool()]);

		const messages = await runAgentLoop({
			provider: toolThenTextProvider("call_1", "echo", '{"text":"hello"}', ["Done"]),
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "use echo" },
			],
			tools: registry,
			projectRoot: "/tmp",
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		// Should return: assistant (tool_calls) + tool result + assistant (text)
		expect(messages).toHaveLength(3);
		expect(messages[0].role).toBe("assistant");
		expect(messages[1].role).toBe("tool");
		expect((messages[1] as { content: string }).content).toBe("echoed: hello");
		expect(messages[2].role).toBe("assistant");
		expect((messages[2] as { content: string }).content).toBe("Done");

		// Should have emitted tool_call and tool_result events
		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		expect(toolCallEvents).toHaveLength(1);
		expect((toolCallEvents[0] as { output: string }).output).toBe("▸ Echo hello");
		const toolResultEvents = events.filter((e) => e.type === "tool_result");
		expect(toolResultEvents).toHaveLength(1);
		expect((toolResultEvents[0] as { output: string }).output).toBe("▸ Echo hello (done)");
	});

	test("handles unknown tool gracefully", async () => {
		const events: AgentEvent[] = [];
		const registry = createToolRegistry([]); // no tools registered

		let callCount = 0;
		const adaptiveProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "nonexistent" };
					yield { type: "tool_call_delta", index: 0, arguments: "{}" };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "I see the error" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const messages = await runAgentLoop({
			provider: adaptiveProvider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: registry,
			projectRoot: "/tmp",
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		// Tool result should contain error
		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect((toolMsg as { content: string }).content).toContain("Unknown tool");
	});

	test("handles tool execution errors gracefully", async () => {
		const throwingTool: Tool = {
			definition: {
				type: "function",
				function: {
					name: "boom",
					description: "Always throws",
					parameters: { type: "object", properties: {}, required: [] },
				},
			},
			mergeable: false,
			formatCall(): string {
				return "▸ Boom";
			},
			async execute(): Promise<ToolResult> {
				throw new Error("disk on fire");
			},
		};

		const registry = createToolRegistry([throwingTool]);
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "call_1", name: "boom" };
					yield { type: "tool_call_delta", index: 0, arguments: "{}" };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "Recovered" };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const messages = await runAgentLoop({
			provider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: registry,
			projectRoot: "/tmp",
			onEvent() {},
			onMessage() {},
		});

		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect((toolMsg as { content: string }).content).toContain("disk on fire");
		// Should have recovered and produced a final text response
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.role).toBe("assistant");
		expect((lastMsg as { content: string }).content).toBe("Recovered");
	});

	test("makes a final tool-free LLM call when iteration limit is reached", async () => {
		let callCount = 0;
		let lastCallHadTools = true;

		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				lastCallHadTools = opts.tools !== undefined;

				if (callCount <= 3) {
					// First 3 calls: always request tool calls
					yield { type: "tool_call_start", index: 0, id: `call_${callCount}`, name: "echo" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"text":"loop"}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					// 4th call: the final summarization call (no tools)
					yield { type: "text", text: "Here is what I found so far." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const registry = createToolRegistry([echoTool()]);

		const messages = await runAgentLoop({
			provider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "loop" },
			],
			tools: registry,
			projectRoot: "/tmp",
			maxIterations: 3,
			onEvent() {},
			onMessage() {},
		});

		// The final LLM call should have been made without tools
		expect(callCount).toBe(4);
		expect(lastCallHadTools).toBe(false);

		// Last message should be the model's synthesized response, not a canned warning
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.role).toBe("assistant");
		expect((lastMsg as { content: string }).content).toBe("Here is what I found so far.");
	});

	test("handles multi-tool workflow (read then edit)", async () => {
		let callCount = 0;
		const multiProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					// First: LLM calls read_file
					yield { type: "tool_call_start", index: 0, id: "call_read", name: "read_file" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"path":"test.txt"}' };
					yield { type: "finish", reason: "tool_calls" };
				} else if (callCount === 2) {
					// Second: LLM calls edit_file
					yield { type: "tool_call_start", index: 0, id: "call_edit", name: "edit_file" };
					yield {
						type: "tool_call_delta",
						index: 0,
						arguments: '{"path":"test.txt","old_string":"hello","new_string":"goodbye"}',
					};
					yield { type: "finish", reason: "tool_calls" };
				} else {
					// Third: LLM responds with text
					yield { type: "text", text: "I updated the file." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		// Create a temp dir with a test file
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-integration-"));
		fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello world");

		const events: AgentEvent[] = [];
		const registry = createToolRegistry([readFileTool, editFileTool]);

		const messages = await runAgentLoop({
			provider: multiProvider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "update the file" },
			],
			tools: registry,
			projectRoot: tmpDir,
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		// Should have: assistant(read) + tool(read result) + assistant(edit) + tool(edit result) + assistant(text)
		expect(messages).toHaveLength(5);
		expect(messages[0].role).toBe("assistant"); // read_file call
		expect(messages[1].role).toBe("tool"); // read result
		expect((messages[1] as { content: string }).content).toContain("hello world");
		expect(messages[2].role).toBe("assistant"); // edit_file call
		expect(messages[3].role).toBe("tool"); // edit result
		expect(messages[4].role).toBe("assistant"); // final text
		expect((messages[4] as { content: string }).content).toBe("I updated the file.");

		// Verify the file was actually modified
		const content = fs.readFileSync(path.join(tmpDir, "test.txt"), "utf-8");
		expect(content).toBe("goodbye world");

		// Verify tool_call events were emitted
		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		expect(toolCallEvents).toHaveLength(2);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("emits status event from provider usage", async () => {
		const events: AgentEvent[] = [];

		// Create a provider that yields a usage event
		const usageProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "Hello" };
				yield { type: "usage", tokenCount: 932, tokenLimit: 64000, display: "932 / 64000 | 1%" };
				yield { type: "finish", reason: "stop" };
			},
		};

		await runAgentLoop({
			provider: usageProvider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			onEvent(event) {
				events.push(event);
			},
			onMessage() {},
		});

		const statusEvents = events.filter((e) => e.type === "status");
		expect(statusEvents).toHaveLength(1);
		expect((statusEvents[0] as { text: string }).text).toBe("932 / 64000 | 1%");
	});

	test("forwards signal to provider.stream()", async () => {
		const captured: ProviderOptions[] = [];
		const controller = new AbortController();
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		await runAgentLoop({
			provider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			signal: controller.signal,
			onEvent() {},
			onMessage() {},
		});

		expect(captured[0].signal).toBe(controller.signal);
	});

	test("clips requested output tokens by remaining context", async () => {
		const configDir = createProviderModelsTempDir();
		try {
			const captured: ProviderOptions[] = [];
			const provider: Provider = {
				id: "openrouter",
				configDir,
				async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
					captured.push(opts);
					yield { type: "text", text: "ok" };
					yield { type: "finish", reason: "stop" };
				},
			};

			await runAgentLoop({
				provider,
				model: "openrouter/free",
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "x".repeat(3200) },
				],
				tools: createToolRegistry([]),
				projectRoot: "/tmp",
				sessionId: "test-session",
				contextWindow: 1000,
				sessionPromptTokens: 100,
				sessionPromptChars: 400,
				onEvent() {},
				onMessage() {},
			});

			expect(captured[0].maxOutputTokens).toBe(189);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("signal defaults to undefined when not provided", async () => {
		const captured: ProviderOptions[] = [];
		const provider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				captured.push(opts);
				yield { type: "text", text: "ok" };
				yield { type: "finish", reason: "stop" };
			},
		};

		await runAgentLoop({
			provider,
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: createToolRegistry([]),
			projectRoot: "/tmp",
			onEvent() {},
			onMessage() {},
		});

		expect(captured[0].signal).toBeUndefined();
	});

	test("aborts at start of iteration when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const events: AgentEvent[] = [];
		await expect(
			runAgentLoop({
				provider: textProvider(["Hello"]),
				model: "test",
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "hi" },
				],
				tools: createToolRegistry([]),
				projectRoot: "/tmp",
				signal: controller.signal,
				onEvent(event) {
					events.push(event);
				},
				onMessage() {},
			}),
		).rejects.toThrow();

		// No events should have been emitted
		expect(events).toHaveLength(0);
	});

	test("aborts between tool executions when signal fires mid-loop", async () => {
		const controller = new AbortController();
		let toolExecutionCount = 0;

		// Tool that aborts the signal on first execution
		const abortingTool: Tool = {
			definition: {
				type: "function",
				function: {
					name: "aborter",
					description: "Aborts on first call",
					parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				},
			},
			mergeable: false,
			formatCall(): string {
				return "▸ Aborter";
			},
			async execute(): Promise<ToolResult> {
				toolExecutionCount++;
				controller.abort();
				return { llmOutput: "done", uiOutput: "done", mergeable: false };
			},
		};

		// Provider returns two tool calls in one response
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "tool_call_start", index: 0, id: "call_1", name: "aborter" };
				yield { type: "tool_call_delta", index: 0, arguments: '{"text":"a"}' };
				yield { type: "tool_call_start", index: 1, id: "call_2", name: "aborter" };
				yield { type: "tool_call_delta", index: 1, arguments: '{"text":"b"}' };
				yield { type: "finish", reason: "tool_calls" };
			},
		};

		const registry = createToolRegistry([abortingTool]);

		await expect(
			runAgentLoop({
				provider,
				model: "test",
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "hi" },
				],
				tools: registry,
				projectRoot: "/tmp",
				signal: controller.signal,
				onEvent() {},
				onMessage() {},
			}),
		).rejects.toThrow();

		// Only the first tool should have executed
		expect(toolExecutionCount).toBe(1);
	});

	test("calls onMessage for each completed message", async () => {
		const registry = createToolRegistry([echoTool()]);
		const collected: Message[] = [];

		const messages = await runAgentLoop({
			provider: toolThenTextProvider("call_1", "echo", '{"text":"hello"}', ["Done"]),
			model: "test",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "use echo" },
			],
			tools: registry,
			projectRoot: "/tmp",
			onEvent() {},
			onMessage(msg) {
				collected.push(msg);
			},
		});

		// onMessage should have been called for each message in order
		expect(collected).toHaveLength(3);
		expect(collected[0].role).toBe("assistant"); // tool_calls
		expect(collected[1].role).toBe("tool"); // tool result
		expect(collected[2].role).toBe("assistant"); // final text
		// Should match return value
		expect(collected).toEqual(messages);
	});
});

describe("parallel task execution", () => {
	/** Create a mock task tool that records execution order and takes a configurable delay. */
	function createMockTaskTool(options: { executionLog: string[]; delays: Record<string, number> }): Tool {
		return {
			definition: {
				type: "function",
				function: {
					name: "task",
					description: "Run a subagent task",
					parameters: {
						type: "object",
						properties: {
							description: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["description", "prompt"],
					},
				},
			},
			mergeable: false,
			formatCall(args: Record<string, unknown>): string {
				return `▸ ${args.description}`;
			},
			async execute(args: Record<string, unknown>): Promise<ToolResult> {
				const desc = args.description as string;
				options.executionLog.push(`start:${desc}`);
				const delay = options.delays[desc] ?? 0;
				if (delay > 0) {
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
				options.executionLog.push(`end:${desc}`);
				return {
					llmOutput: `result of ${desc}`,
					uiOutput: null,
					mergeable: false,
					summary: `summary:${desc}`,
				};
			},
		};
	}

	/** Provider that yields N task tool_calls on call 1, then text on call 2. */
	function multiTaskProvider(tasks: { id: string; description: string; prompt: string }[]): Provider {
		let callCount = 0;
		return {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					for (let i = 0; i < tasks.length; i++) {
						yield { type: "tool_call_start", index: i, id: tasks[i].id, name: "task" };
						yield {
							type: "tool_call_delta",
							index: i,
							arguments: JSON.stringify({ description: tasks[i].description, prompt: tasks[i].prompt }),
						};
					}
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "Done." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};
	}

	test("multiple task tool calls run concurrently", async () => {
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			delays: { "task-A": 50, "task-B": 50 },
		});

		const start = performance.now();
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent() {},
			onMessage() {},
		});
		const elapsed = performance.now() - start;

		// Both tasks started before either ended (concurrent execution)
		const startA = executionLog.indexOf("start:task-A");
		const startB = executionLog.indexOf("start:task-B");
		const endA = executionLog.indexOf("end:task-A");
		const endB = executionLog.indexOf("end:task-B");
		expect(startA).toBeLessThan(endA);
		expect(startB).toBeLessThan(endB);
		// Both started before either finished
		expect(startA).toBeLessThan(endB);
		expect(startB).toBeLessThan(endA);

		// Wall time should be ~50ms (parallel), not ~100ms (sequential)
		// Use generous threshold for CI flakiness
		expect(elapsed).toBeLessThan(90);
	});

	test("parallel task UI events stream on completion, messages stay in dispatch order", async () => {
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			// task-B completes faster than task-A
			delays: { "task-A": 50, "task-B": 10 },
		});

		const events: AgentEvent[] = [];
		const collectedMessages: Message[] = [];
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(e) {
				events.push(e);
			},
			onMessage(m) {
				collectedMessages.push(m);
			},
		});

		// tool_result events arrive in completion order (tc2 finishes first)
		const resultEvents = events.filter((e) => e.type === "tool_result");
		expect(resultEvents).toHaveLength(2);
		expect((resultEvents[0] as { id: string }).id).toBe("tc2");
		expect((resultEvents[1] as { id: string }).id).toBe("tc1");

		// Tool messages in conversation should still be in dispatch order
		const toolMsgs = collectedMessages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
		expect((toolMsgs[0] as ToolMessage).tool_call_id).toBe("tc1");
		expect((toolMsgs[1] as ToolMessage).tool_call_id).toBe("tc2");
	});

	test("formatCall events are emitted upfront for all tool calls", async () => {
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			delays: { "task-A": 20, "task-B": 20 },
		});

		const events: AgentEvent[] = [];
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(e) {
				events.push(e);
			},
			onMessage() {},
		});

		// All tool_call events should come before any tool_result events
		const toolCallIndices = events.map((e, i) => (e.type === "tool_call" ? i : -1)).filter((i) => i >= 0);
		const toolResultIndices = events.map((e, i) => (e.type === "tool_result" ? i : -1)).filter((i) => i >= 0);

		expect(toolCallIndices).toHaveLength(2);
		expect(toolResultIndices).toHaveLength(2);

		// Every tool_call should precede every tool_result
		for (const ci of toolCallIndices) {
			for (const ri of toolResultIndices) {
				expect(ci).toBeLessThan(ri);
			}
		}
	});

	test("single task call still executes sequentially (no parallel overhead)", async () => {
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			delays: { "task-A": 10 },
		});

		await runAgentLoop({
			provider: multiTaskProvider([{ id: "tc1", description: "task-A", prompt: "do A" }]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent() {},
			onMessage() {},
		});

		expect(executionLog).toEqual(["start:task-A", "end:task-A"]);
	});

	test("mixed tool calls: non-task tools remain sequential, task tools are parallel", async () => {
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			delays: { "task-A": 30, "task-B": 30 },
		});

		const echoExecOrder: string[] = [];
		const echo: Tool = {
			definition: {
				type: "function",
				function: {
					name: "echo",
					description: "Echo",
					parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				},
			},
			mergeable: true,
			formatCall(args: Record<string, unknown>): string {
				return `▸ ${args.text}`;
			},
			async execute(args: Record<string, unknown>): Promise<ToolResult> {
				echoExecOrder.push(`echo:${args.text}`);
				return { llmOutput: `echoed: ${args.text}`, uiOutput: null, mergeable: true };
			},
		};

		// Provider that yields: echo("first"), task-A, task-B, echo("last")
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					yield { type: "tool_call_start", index: 0, id: "e1", name: "echo" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"text":"first"}' };
					yield { type: "tool_call_start", index: 1, id: "t1", name: "task" };
					yield {
						type: "tool_call_delta",
						index: 1,
						arguments: '{"description":"task-A","prompt":"A"}',
					};
					yield { type: "tool_call_start", index: 2, id: "t2", name: "task" };
					yield {
						type: "tool_call_delta",
						index: 2,
						arguments: '{"description":"task-B","prompt":"B"}',
					};
					yield { type: "tool_call_start", index: 3, id: "e2", name: "echo" };
					yield { type: "tool_call_delta", index: 3, arguments: '{"text":"last"}' };
					yield { type: "finish", reason: "tool_calls" };
				} else {
					yield { type: "text", text: "All done." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const events: AgentEvent[] = [];
		const collectedMessages: Message[] = [];
		await runAgentLoop({
			provider,
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([echo, taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(e) {
				events.push(e);
			},
			onMessage(m) {
				collectedMessages.push(m);
			},
		});

		// echo("first") runs sequentially before the tasks
		expect(echoExecOrder[0]).toBe("echo:first");

		// Both tasks should have run (concurrently)
		expect(executionLog).toContain("start:task-A");
		expect(executionLog).toContain("start:task-B");
		expect(executionLog).toContain("end:task-A");
		expect(executionLog).toContain("end:task-B");

		// echo("last") runs sequentially after the tasks
		expect(echoExecOrder[1]).toBe("echo:last");

		// Result events: e1 (sequential), then t1/t2 in completion order (parallel,
		// same delay so order may vary), then e2 (sequential after parallel group).
		const resultIds = events.filter((e) => e.type === "tool_result").map((e) => (e as { id: string }).id);
		expect(resultIds[0]).toBe("e1");
		expect(resultIds.slice(1, 3).sort()).toEqual(["t1", "t2"]);
		expect(resultIds[3]).toBe("e2");

		// onMessage calls (conversation/DB) preserve dispatch order regardless of completion order
		const toolMsgIds = collectedMessages.filter((m) => m.role === "tool").map((m) => (m as ToolMessage).tool_call_id);
		expect(toolMsgIds).toEqual(["e1", "t1", "t2", "e2"]);
	});

	test("tool_result events stream incrementally as each parallel task completes", async () => {
		const eventTimestamps: { id: string; time: number }[] = [];
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			// task-C is instant, task-A is slow, task-B is in between
			delays: { "task-A": 80, "task-B": 40, "task-C": 5 },
		});

		const start = performance.now();
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
				{ id: "tc3", description: "task-C", prompt: "do C" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(e) {
				if (e.type === "tool_result") {
					eventTimestamps.push({ id: (e as { id: string }).id, time: performance.now() - start });
				}
			},
			onMessage() {},
		});

		// All three tool_result events should have been emitted
		expect(eventTimestamps).toHaveLength(3);

		// Events should arrive in completion order: tc3 (5ms), tc2 (40ms), tc1 (80ms)
		expect(eventTimestamps[0].id).toBe("tc3");
		expect(eventTimestamps[1].id).toBe("tc2");
		expect(eventTimestamps[2].id).toBe("tc1");

		// The first event (tc3) should arrive well before the last (tc1),
		// proving incremental streaming rather than batching
		const tc3Time = eventTimestamps[0].time;
		const tc1Time = eventTimestamps[2].time;
		expect(tc1Time - tc3Time).toBeGreaterThan(20);
	});

	test("onMessage calls are batched after all parallel tasks complete", async () => {
		const messageTimestamps: { id: string; time: number }[] = [];
		const executionLog: string[] = [];
		const taskTool = createMockTaskTool({
			executionLog,
			delays: { "task-A": 60, "task-B": 10 },
		});

		const start = performance.now();
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([taskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent() {},
			onMessage(m) {
				if (m.role === "tool") {
					messageTimestamps.push({
						id: (m as ToolMessage).tool_call_id,
						time: performance.now() - start,
					});
				}
			},
		});

		// Both messages should arrive after all tasks complete (~60ms)
		expect(messageTimestamps).toHaveLength(2);

		// Messages arrive in dispatch order
		expect(messageTimestamps[0].id).toBe("tc1");
		expect(messageTimestamps[1].id).toBe("tc2");

		// Both messages should arrive at roughly the same time (after slowest task)
		const timeDiff = Math.abs(messageTimestamps[1].time - messageTimestamps[0].time);
		expect(timeDiff).toBeLessThan(20); // effectively simultaneous
	});

	test("parallel task error does not block other tasks from emitting results", async () => {
		const eventIds: string[] = [];

		// Custom tool: task-A throws, task-B succeeds
		const errorTaskTool: Tool = {
			definition: {
				type: "function",
				function: {
					name: "task",
					description: "Run a subagent task",
					parameters: {
						type: "object",
						properties: {
							description: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["description", "prompt"],
					},
				},
			},
			mergeable: false,
			formatCall(args: Record<string, unknown>): string {
				return `▸ ${args.description}`;
			},
			async execute(args: Record<string, unknown>): Promise<ToolResult> {
				const desc = args.description as string;
				if (desc === "task-A") {
					await new Promise((resolve) => setTimeout(resolve, 5));
					throw new Error("task-A exploded");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
				return {
					llmOutput: `result of ${desc}`,
					uiOutput: null,
					mergeable: false,
					summary: `summary:${desc}`,
				};
			},
		};

		const collectedMessages: Message[] = [];
		await runAgentLoop({
			provider: multiTaskProvider([
				{ id: "tc1", description: "task-A", prompt: "do A" },
				{ id: "tc2", description: "task-B", prompt: "do B" },
			]),
			model: "test",
			messages: [{ role: "user", content: "go" }],
			tools: createToolRegistry([errorTaskTool]),
			projectRoot: "/tmp",
			sessionId: "test-session",
			onEvent(e) {
				if (e.type === "tool_result") {
					eventIds.push((e as { id: string }).id);
				}
			},
			onMessage(m) {
				collectedMessages.push(m);
			},
		});

		// Both tool_result events should be emitted (error is caught per-task)
		expect(eventIds).toHaveLength(2);
		expect(eventIds).toContain("tc1");
		expect(eventIds).toContain("tc2");

		// Messages should be in dispatch order
		const toolMsgs = collectedMessages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
		expect((toolMsgs[0] as ToolMessage).tool_call_id).toBe("tc1");
		expect((toolMsgs[0] as { content: string }).content).toContain("task-A exploded");
		expect((toolMsgs[1] as ToolMessage).tool_call_id).toBe("tc2");
		expect((toolMsgs[1] as { content: string }).content).toBe("result of task-B");
	});
});
