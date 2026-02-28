import type { AssistantMessage, Message, Provider, ToolCallContent, ToolMessage } from "./provider/provider";
import type { ToolRegistry } from "./tool/tool";

const DEFAULT_MAX_ITERATIONS = 20;

export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; output: string; isError?: boolean };

export interface AgentLoopOptions {
	provider: Provider;
	model: string;
	messages: Message[];
	tools: ToolRegistry;
	projectRoot: string;
	maxIterations?: number;
	onEvent: (event: AgentEvent) => void;
	onMessage: (msg: Message) => void;
}

interface AccumulatedToolCall {
	id: string;
	name: string;
	arguments: string;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<Message[]> {
	const { provider, model, tools, projectRoot, onEvent, onMessage } = options;
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	// Working copy of messages — starts with what was passed in
	const conversation = [...options.messages];
	// New messages produced by this loop (what we return)
	const newMessages: Message[] = [];

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		let textContent = "";
		const toolCalls = new Map<number, AccumulatedToolCall>();
		let finishReason: "stop" | "tool_calls" = "stop";

		// Call the provider
		for await (const event of provider.stream({
			model,
			messages: conversation,
			tools: tools.definitions.length > 0 ? tools.definitions : undefined,
		})) {
			switch (event.type) {
				case "text":
					textContent += event.text;
					onEvent({ type: "text", text: event.text });
					break;
				case "tool_call_start":
					toolCalls.set(event.index, { id: event.id, name: event.name, arguments: "" });
					break;
				case "tool_call_delta": {
					const tc = toolCalls.get(event.index);
					if (tc) tc.arguments += event.arguments;
					break;
				}
				case "finish":
					finishReason = event.reason;
					break;
			}
		}

		if (finishReason === "stop" || toolCalls.size === 0) {
			// Normal text response — done
			const assistantMsg: AssistantMessage = { role: "assistant", content: textContent };
			conversation.push(assistantMsg);
			newMessages.push(assistantMsg);
			onMessage(assistantMsg);
			return newMessages;
		}

		// Tool calls response — build assistant message with tool_calls
		const toolCallContents: ToolCallContent[] = [];
		for (const [, tc] of toolCalls) {
			toolCallContents.push({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: tc.arguments },
			});
		}

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: textContent || null,
			tool_calls: toolCallContents,
		};
		conversation.push(assistantMsg);
		newMessages.push(assistantMsg);
		onMessage(assistantMsg);

		// Execute each tool call sequentially
		for (const tc of toolCallContents) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				args = {};
			}

			onEvent({ type: "tool_call", id: tc.id, name: tc.function.name, arguments: args });

			const tool = tools.get(tc.function.name);
			let output: string;
			let isError: boolean | undefined;

			if (!tool) {
				output = `Unknown tool: ${tc.function.name}`;
				isError = true;
			} else {
				try {
					const result = await tool.execute(args, { projectRoot });
					output = result.output;
					isError = result.isError;
				} catch (err) {
					output = `Tool execution error: ${(err as Error).message}`;
					isError = true;
				}
			}

			onEvent({ type: "tool_result", id: tc.id, name: tc.function.name, output, isError });

			const toolMsg: ToolMessage = { role: "tool", content: output, tool_call_id: tc.id };
			conversation.push(toolMsg);
			newMessages.push(toolMsg);
			onMessage(toolMsg);
		}

		// Loop continues — provider will be called again with updated conversation
	}

	// Hit max iterations — append a warning message
	const warningMsg: AssistantMessage = {
		role: "assistant",
		content: `Stopped after ${maxIterations} iteration${maxIterations === 1 ? "" : "s"} — possible runaway loop.`,
	};
	conversation.push(warningMsg);
	newMessages.push(warningMsg);
	onMessage(warningMsg);
	return newMessages;
}
