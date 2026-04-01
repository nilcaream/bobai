import type { Message, ToolDefinition } from "./provider";

// --- Anthropic content block types ---

export interface AnthropicTextBlock {
	type: "text";
	text: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

// --- Anthropic message types ---

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

export interface ConvertedMessages {
	system: string | undefined;
	messages: AnthropicMessage[];
}

// --- Anthropic tool type ---

export interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

// --- Conversion functions ---

export function convertMessagesToAnthropic(messages: Message[]): ConvertedMessages {
	// Extract and concatenate system messages
	const systemParts: string[] = [];
	const nonSystem: Message[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			systemParts.push(msg.content);
		} else {
			nonSystem.push(msg);
		}
	}

	const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

	// Convert non-system messages, grouping consecutive tool results
	const result: AnthropicMessage[] = [];

	for (let i = 0; i < nonSystem.length; i++) {
		const msg = nonSystem[i];

		if (msg.role === "user") {
			result.push({ role: "user", content: msg.content });
		} else if (msg.role === "assistant") {
			const blocks: AnthropicContentBlock[] = [];

			// Add text block only if content is a non-empty string
			if (msg.content) {
				blocks.push({ type: "text", text: msg.content });
			}

			// Add tool_use blocks
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					blocks.push({
						type: "tool_use",
						id: tc.id,
						name: tc.function.name,
						input: parseArguments(tc.function.arguments),
					});
				}
			}

			result.push({ role: "assistant", content: blocks });
		} else if (msg.role === "tool") {
			// Check if the previous result message is already a grouped tool_result user message
			const prev = result[result.length - 1];
			if (prev && prev.role === "user" && Array.isArray(prev.content)) {
				// Append to existing grouped tool_result message
				prev.content.push({
					type: "tool_result",
					tool_use_id: msg.tool_call_id,
					content: msg.content,
				});
			} else {
				// Start a new user message with tool_result blocks
				result.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: msg.tool_call_id,
							content: msg.content,
						},
					],
				});
			}
		}
	}

	return { system, messages: result };
}

export function convertToolsToAnthropic(tools: ToolDefinition[]): AnthropicTool[] {
	return tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters,
	}));
}

function parseArguments(args: string): Record<string, unknown> {
	try {
		return JSON.parse(args);
	} catch {
		return { _raw: args };
	}
}
