/**
 * Conversions between the internal message/tool format and the
 * Amazon Bedrock Converse API request/response format.
 *
 * Bedrock Converse wire types are defined inline here so this file
 * has no external dependencies other than the provider types.
 */

import type { AssistantMessage, Message, ToolDefinition, ToolMessage } from "./provider";

// ---------------------------------------------------------------------------
// Bedrock Converse wire types
// ---------------------------------------------------------------------------

export interface BedrockTextContent {
	text: string;
}

export interface BedrockToolUseContent {
	toolUse: {
		toolUseId: string;
		name: string;
		input: Record<string, unknown>;
	};
}

export interface BedrockToolResultContent {
	toolResult: {
		toolUseId: string;
		content: Array<{ text: string }>;
		status?: "success" | "error";
	};
}

export type BedrockContent = BedrockTextContent | BedrockToolUseContent | BedrockToolResultContent;

export interface BedrockConverseMessage {
	role: "user" | "assistant";
	content: BedrockContent[];
}

export interface BedrockSystemContent {
	text: string;
}

export interface BedrockToolSpec {
	toolSpec: {
		name: string;
		description: string;
		inputSchema: {
			json: Record<string, unknown>;
		};
	};
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Converts the internal message array to Bedrock Converse format.
 *
 * Key differences from internal format:
 * - System messages are extracted into a separate `system` array.
 * - Content is always an array (never a bare string).
 * - Tool calls in assistant messages become `toolUse` content blocks.
 * - Tool result messages (role: "tool") are consecutive runs that get merged
 *   into a single user message with `toolResult` content blocks.
 */
export function convertMessagesToConverse(messages: Message[]): {
	messages: BedrockConverseMessage[];
	system: BedrockSystemContent[] | undefined;
} {
	const system: BedrockSystemContent[] = [];
	const bedrockMessages: BedrockConverseMessage[] = [];

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "system") {
			system.push({ text: msg.content });
			i++;
			continue;
		}

		if (msg.role === "user") {
			bedrockMessages.push({
				role: "user",
				content: [{ text: msg.content }],
			});
			i++;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const content: BedrockContent[] = [];

			if (assistantMsg.content) {
				content.push({ text: assistantMsg.content });
			}

			for (const tc of assistantMsg.tool_calls ?? []) {
				let input: Record<string, unknown> = {};
				try {
					input = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
				} catch {
					// leave as empty object if arguments are malformed
				}
				content.push({
					toolUse: {
						toolUseId: tc.id,
						name: tc.function.name,
						input,
					},
				});
			}

			// Bedrock requires at least one content block
			if (content.length === 0) {
				content.push({ text: "" });
			}

			bedrockMessages.push({ role: "assistant", content });
			i++;
			continue;
		}

		if (msg.role === "tool") {
			// Collect all consecutive tool-result messages into one user turn
			const toolResults: BedrockToolResultContent[] = [];
			while (i < messages.length && messages[i].role === "tool") {
				const toolMsg = messages[i] as ToolMessage;
				toolResults.push({
					toolResult: {
						toolUseId: toolMsg.tool_call_id,
						content: [{ text: toolMsg.content }],
					},
				});
				i++;
			}
			bedrockMessages.push({ role: "user", content: toolResults });
			continue;
		}

		// Unknown role — skip
		i++;
	}

	return {
		messages: bedrockMessages,
		system: system.length > 0 ? system : undefined,
	};
}

// ---------------------------------------------------------------------------
// Tool definition conversion
// ---------------------------------------------------------------------------

/**
 * Converts internal ToolDefinition array to Bedrock Converse toolConfig format.
 */
export function convertToolsToConverse(tools: ToolDefinition[]): { tools: BedrockToolSpec[] } {
	return {
		tools: tools.map((t) => ({
			toolSpec: {
				name: t.function.name,
				description: t.function.description,
				inputSchema: {
					json: t.function.parameters,
				},
			},
		})),
	};
}
