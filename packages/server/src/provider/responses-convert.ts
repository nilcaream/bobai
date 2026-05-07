import type { Message, ResponsesItemReasoningState, ToolDefinition } from "./provider";
import type { ReasoningCapabilities } from "./reasoning-capabilities";

export type ResponsesInputItem =
	| { role: "developer"; content: string }
	| { role: "user"; content: { type: "input_text"; text: string }[] }
	| { type: "message"; role: "assistant"; content: { type: "output_text"; text: string }[]; status: "completed" }
	| {
			type: "reasoning";
			id?: string;
			summary?: { type: "summary_text"; text: string }[];
			encrypted_content?: string;
	  }
	| { type: "function_call"; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: boolean;
}

function canReplayResponsesReasoning(capabilities?: ReasoningCapabilities): boolean {
	return capabilities?.family === "openai-responses" && capabilities.supportsReplay;
}

function convertResponsesReasoningItem(
	reasoning: ResponsesItemReasoningState,
): Extract<ResponsesInputItem, { type: "reasoning" }> {
	return {
		type: "reasoning",
		...(reasoning.id ? { id: reasoning.id } : {}),
		...(reasoning.summary ? { summary: [{ type: "summary_text", text: reasoning.summary }] } : {}),
		...(reasoning.encryptedContent ? { encrypted_content: reasoning.encryptedContent } : {}),
	};
}

export function convertMessagesToResponses(messages: Message[], capabilities?: ReasoningCapabilities): ResponsesInputItem[] {
	const result: ResponsesInputItem[] = [];

	const systemParts: string[] = [];
	const nonSystemMessages: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "system") {
			systemParts.push(msg.content);
		} else {
			nonSystemMessages.push(msg);
		}
	}

	if (systemParts.length > 0) {
		result.push({ role: "developer", content: systemParts.join("\n\n") });
	}

	for (const msg of nonSystemMessages) {
		if (msg.role === "user") {
			result.push({
				role: "user",
				content: [{ type: "input_text", text: msg.content }],
			});
		} else if (msg.role === "assistant") {
			if (msg.content && msg.content.length > 0) {
				result.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: msg.content }],
					status: "completed",
				});
			}
			if (canReplayResponsesReasoning(capabilities) && msg.reasoning) {
				for (const reasoning of msg.reasoning) {
					if (reasoning.kind === "responses-item") {
						result.push(convertResponsesReasoningItem(reasoning));
					}
				}
			}
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					result.push({
						type: "function_call",
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
					});
				}
			}
		} else if (msg.role === "tool") {
			result.push({
				type: "function_call_output",
				call_id: msg.tool_call_id,
				output: msg.content,
			});
		}
	}

	return result;
}

export function convertToolsToResponses(tools: ToolDefinition[]): ResponsesTool[] {
	return tools.map((tool) => ({
		type: "function" as const,
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
		strict: false,
	}));
}
