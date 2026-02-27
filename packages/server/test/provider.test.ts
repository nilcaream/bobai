import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Message,
	StreamEvent,
	SystemMessage,
	ToolDefinition,
	ToolMessage,
	UserMessage,
} from "../src/provider/provider";
import { ProviderError } from "../src/provider/provider";

describe("ProviderError", () => {
	test("stores status and body", () => {
		const err = new ProviderError(401, "Unauthorized");
		expect(err.status).toBe(401);
		expect(err.body).toBe("Unauthorized");
		expect(err.message).toBe("Provider error (401): Unauthorized");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("type contracts", () => {
	test("StreamEvent discriminated union covers all variants", () => {
		const events: StreamEvent[] = [
			{ type: "text", text: "hello" },
			{ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
			{ type: "tool_call_delta", index: 0, arguments: '{"pat' },
			{ type: "finish", reason: "stop" },
			{ type: "finish", reason: "tool_calls" },
		];
		expect(events).toHaveLength(5);
		expect(events[0].type).toBe("text");
		expect(events[3].type).toBe("finish");
	});

	test("ToolDefinition matches OpenAI function-calling format", () => {
		const def: ToolDefinition = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "File path" } },
					required: ["path"],
				},
			},
		};
		expect(def.type).toBe("function");
		expect(def.function.name).toBe("read_file");
	});

	test("Message union supports all four roles", () => {
		const system: SystemMessage = { role: "system", content: "You are helpful" };
		const user: UserMessage = { role: "user", content: "hi" };
		const assistant: AssistantMessage = { role: "assistant", content: "hello" };
		const assistantWithTools: AssistantMessage = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
		};
		const toolResult: ToolMessage = { role: "tool", content: "file contents", tool_call_id: "call_1" };

		const msgs: Message[] = [system, user, assistant, assistantWithTools, toolResult];
		expect(msgs).toHaveLength(5);
		expect(assistantWithTools.tool_calls).toHaveLength(1);
		expect(toolResult.tool_call_id).toBe("call_1");
	});
});
