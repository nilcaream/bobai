import { writeCompactionDump } from "./compaction/dump";
import { compactMessages } from "./compaction/engine";
import type { Logger } from "./log/logger";
import { createIsolatedTurnProvider } from "./provider/isolated-turn";
import type { AssistantMessage, Message, Provider, ToolCallContent, ToolMessage } from "./provider/provider";
import type { ToolRegistry } from "./tool/tool";

const DEFAULT_MAX_ITERATIONS = 64;

export const EMERGENCY_THRESHOLD = 0.85;

export function shouldEmergencyCompact(promptTokens: number, contextWindow: number): boolean {
	if (contextWindow <= 0 || promptTokens <= 0) return false;
	return promptTokens / contextWindow >= EMERGENCY_THRESHOLD;
}

export function emergencyCompactConversation(
	conversation: Message[],
	promptTokens: number,
	contextWindow: number,
	tools: ToolRegistry,
	logDir?: string,
	logger?: Logger,
	onReadFileCompacted?: (toolCallId: string, callArgs: Record<string, unknown>) => void,
	sessionId?: string,
): Message[] {
	if (!shouldEmergencyCompact(promptTokens, contextWindow)) return conversation;

	const beforeEmergency = [...conversation];
	const compacted = compactMessages({
		messages: conversation,
		context: {
			promptTokens,
			contextWindow,
		},
		tools,
		sessionId,
		onReadFileCompacted,
	});

	if (compacted !== conversation) {
		if (logDir) {
			const { preFile } = writeCompactionDump(logDir, beforeEmergency, compacted, "emergency");
			if (preFile && logger) {
				logger.info("COMPACTION", `emergency mid-loop compaction: ${preFile}`);
			}
		}
		return compacted;
	}

	return conversation;
}

export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; output: string }
	| {
			type: "tool_result";
			id: string;
			output: string | null;
			mergeable: boolean;
			summary?: string;
			metadata?: Record<string, unknown>;
	  }
	| { type: "status"; text: string };

export interface AgentLoopOptions {
	provider: Provider;
	model: string;
	messages: Message[];
	tools: ToolRegistry;
	projectRoot: string;
	accessibleDirectories?: string[];
	sessionId: string;
	maxIterations?: number;
	signal?: AbortSignal;
	initiator?: "user" | "agent";
	contextWindow?: number;
	/** Original uncompacted messages from DB, for emergency compaction input. */
	rawMessages?: Message[];
	logger?: Logger;
	logDir?: string;
	/** Called when a read_file tool output is compacted during emergency compaction. */
	onReadFileCompacted?: (toolCallId: string, callArgs: Record<string, unknown>) => void;
	onEvent: (event: AgentEvent) => void;
	onMessage: (msg: Message) => void;
}

interface AccumulatedToolCall {
	id: string;
	name: string;
	arguments: string;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<Message[]> {
	const { provider, model, tools, projectRoot, accessibleDirectories, sessionId, onEvent, onMessage, signal, initiator } =
		options;
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new Error(`Invalid maxIterations: ${maxIterations}. Must be a positive integer.`);
	}

	// Working copy of messages — starts with what was passed in
	const conversation = [...options.messages];
	// New messages produced by this loop (what we return)
	const newMessages: Message[] = [];

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		// Abort if the signal has been triggered (e.g. WebSocket closed)
		signal?.throwIfAborted();

		let textContent = "";
		const toolCalls = new Map<number, AccumulatedToolCall>();
		let finishReason: "stop" | "tool_calls" = "stop";

		// Call the provider
		for await (const event of provider.stream({
			model,
			messages: conversation,
			tools: tools.definitions.length > 0 ? tools.definitions : undefined,
			signal,
			initiator,
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
				case "usage":
					onEvent({ type: "status", text: event.display });
					break;
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

		// --- Tool execution ---
		// Partition tool calls: consecutive `task` calls form a parallel group,
		// everything else executes sequentially.

		interface ToolCallGroup {
			parallel: boolean;
			items: ToolCallContent[];
		}
		const groups: ToolCallGroup[] = [];
		for (const tc of toolCallContents) {
			const isTask = tc.function.name === "task";
			const lastGroup = groups[groups.length - 1];
			if (isTask && lastGroup?.parallel) {
				lastGroup.items.push(tc);
			} else {
				groups.push({ parallel: isTask, items: [tc] });
			}
		}

		// Emit formatCall for ALL tool calls upfront so the UI shows all panels immediately
		for (const tc of toolCallContents) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				args = {};
			}
			const tool = tools.get(tc.function.name);
			const callOutput = tool ? tool.formatCall(args) : `[${tc.function.name}]`;
			onEvent({ type: "tool_call", id: tc.id, output: callOutput });
		}

		for (const group of groups) {
			if (group.parallel && group.items.length > 1) {
				// Parallel task execution — each task gets an isolated provider
				interface ParallelResult {
					tc: ToolCallContent;
					llmOutput: string;
					uiOutput: string | null;
					mergeable: boolean;
					summary?: string;
					resultMetadata?: Record<string, unknown>;
				}

				const promises = group.items.map(async (tc): Promise<ParallelResult> => {
					let args: Record<string, unknown>;
					try {
						args = JSON.parse(tc.function.arguments);
					} catch {
						args = {};
					}
					const tool = tools.get(tc.function.name);
					if (!tool) {
						return {
							tc,
							llmOutput: `Unknown tool: ${tc.function.name}`,
							uiOutput: `Unknown tool: ${tc.function.name}`,
							mergeable: false,
						};
					}
					try {
						const isolated = createIsolatedTurnProvider(provider);
						const result = await tool.execute(args, {
							projectRoot,
							accessibleDirectories,
							sessionId,
							toolCallId: tc.id,
							provider: isolated,
						});
						return {
							tc,
							llmOutput: result.llmOutput,
							uiOutput: result.uiOutput,
							mergeable: result.mergeable,
							summary: result.summary,
							resultMetadata: result.metadata,
						};
					} catch (err) {
						return {
							tc,
							llmOutput: `Tool execution error: ${(err as Error).message}`,
							uiOutput: `Tool execution error: ${(err as Error).message}`,
							mergeable: false,
						};
					}
				});

				const results = await Promise.all(promises);

				// Inject results in dispatch order
				for (const r of results) {
					onEvent({
						type: "tool_result",
						id: r.tc.id,
						output: r.uiOutput,
						mergeable: r.mergeable,
						summary: r.summary,
						metadata: r.resultMetadata,
					});
					const toolMsg: ToolMessage = { role: "tool", content: r.llmOutput, tool_call_id: r.tc.id };
					conversation.push(toolMsg);
					newMessages.push(toolMsg);
					onMessage(toolMsg);
				}
			} else {
				// Sequential execution (non-task tools, or a single task call)
				for (const tc of group.items) {
					let args: Record<string, unknown>;
					try {
						args = JSON.parse(tc.function.arguments);
					} catch {
						args = {};
					}

					const tool = tools.get(tc.function.name);

					let llmOutput: string;
					let uiOutput: string | null = null;
					let mergeable = false;
					let summary: string | undefined;
					let resultMetadata: Record<string, unknown> | undefined;

					if (!tool) {
						llmOutput = `Unknown tool: ${tc.function.name}`;
						uiOutput = `Unknown tool: ${tc.function.name}`;
					} else {
						try {
							const result = await tool.execute(args, { projectRoot, accessibleDirectories, sessionId, toolCallId: tc.id });
							llmOutput = result.llmOutput;
							uiOutput = result.uiOutput;
							mergeable = result.mergeable;
							summary = result.summary;
							resultMetadata = result.metadata;
						} catch (err) {
							llmOutput = `Tool execution error: ${(err as Error).message}`;
							uiOutput = `Tool execution error: ${(err as Error).message}`;
						}
					}

					onEvent({ type: "tool_result", id: tc.id, output: uiOutput, mergeable, summary, metadata: resultMetadata });

					const toolMsg: ToolMessage = { role: "tool", content: llmOutput, tool_call_id: tc.id };
					conversation.push(toolMsg);
					newMessages.push(toolMsg);
					onMessage(toolMsg);

					// Check abort between tool executions
					signal?.throwIfAborted();
				}
			}

			// Check abort between groups
			signal?.throwIfAborted();
		}

		// Emergency compaction: if we've crossed 85% context usage, compact from raw data before next iteration
		if (options.contextWindow && options.contextWindow > 0 && options.rawMessages) {
			const currentPromptTokens = provider.getTurnPromptTokens?.() ?? 0;
			const rawPlusNew = [...options.rawMessages, ...newMessages];
			const compacted = emergencyCompactConversation(
				rawPlusNew,
				currentPromptTokens,
				options.contextWindow,
				tools,
				options.logDir,
				options.logger,
				options.onReadFileCompacted,
				options.sessionId,
			);
			if (compacted !== rawPlusNew) {
				conversation.length = 0;
				conversation.push(...compacted);
			}
		}

		// Loop continues — provider will be called again with updated conversation
	}

	// Hit max iterations — nudge the model and make one final call without tools
	const nudge: Message = {
		role: "user",
		content: "You've reached the tool call limit. Respond now with what you have — do not call any more tools.",
	};
	conversation.push(nudge);

	let finalText = "";
	for await (const event of provider.stream({ model, messages: conversation, signal, initiator })) {
		if (event.type === "text") {
			finalText += event.text;
			onEvent({ type: "text", text: event.text });
		} else if (event.type === "usage") {
			onEvent({ type: "status", text: event.display });
		}
	}

	const finalMsg: AssistantMessage = { role: "assistant", content: finalText };
	conversation.push(finalMsg);
	newMessages.push(finalMsg);
	onMessage(finalMsg);
	return newMessages;
}
