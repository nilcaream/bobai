import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../src/agent-loop";
import { runAgentLoop } from "../src/agent-loop";
import type { Message, Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { editFileTool } from "../src/tool/edit-file";
import { readFileTool } from "../src/tool/read-file";
import type { Tool, ToolContext, ToolResult } from "../src/tool/tool";
import { createToolRegistry } from "../src/tool/tool";

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
		async execute(args: Record<string, unknown>): Promise<ToolResult> {
			return { output: `echoed: ${args.text}` };
		},
	};
}

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
		const toolResultEvents = events.filter((e) => e.type === "tool_result");
		expect(toolResultEvents).toHaveLength(1);
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

	test("respects max iterations safety valve", async () => {
		// Provider always requests tool calls — should stop after 3 iterations
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "tool_call_start", index: 0, id: `call_${Math.random()}`, name: "echo" };
				yield { type: "tool_call_delta", index: 0, arguments: '{"text":"loop"}' };
				yield { type: "finish", reason: "tool_calls" };
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
			maxIterations: 3, // Use a small number for testing
			onEvent() {},
			onMessage() {},
		});

		// Should have stopped and the last message should indicate the limit
		// 3 iterations × (1 assistant + 1 tool) = 6, plus a final error message
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.role).toBe("assistant");
		expect((lastMsg as { content: string }).content).toContain("iteration");
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
