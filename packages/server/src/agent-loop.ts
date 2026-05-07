import { setSnapshot } from "./compaction/cache";
import { compactToBudget } from "./compaction/compact-to-budget";
import { writeCompactionDump } from "./compaction/dump";
import { COMPACTION_OUTPUT_TARGET, computeCharBudget, EMERGENCY_TARGET, totalContentChars } from "./compaction/strength";
import type { DbGuard } from "./db-guard";
import type { Logger } from "./log/logger";
import { getScope } from "./log/logger";
import { createIsolatedTurnProvider } from "./provider/isolated-turn";
import type {
	AssistantMessage,
	Message,
	Provider,
	ReasoningDelta,
	ReasoningState,
	ToolCallContent,
	ToolMessage,
} from "./provider/provider";
import type { ToolRegistry } from "./tool/tool";

const DEFAULT_MAX_ITERATIONS = 64;

export function shouldEmergencyCompact(
	promptTokens: number,
	promptChars: number,
	contextWindow: number,
	messages: { content: string | null | undefined }[],
): boolean {
	const charBudget = computeCharBudget(contextWindow, EMERGENCY_TARGET, promptTokens, promptChars);
	if (charBudget <= 0) return false;
	return totalContentChars(messages) > charBudget;
}

export function emergencyCompactConversation(
	conversation: Message[],
	promptTokens: number,
	promptChars: number,
	contextWindow: number,
	tools: ToolRegistry,
	logDir?: string,
	logger?: Logger,
	onReadFileCompacted?: (toolCallId: string, callArgs: Record<string, unknown>) => void,
	sessionId?: string,
): Message[] {
	if (!shouldEmergencyCompact(promptTokens, promptChars, contextWindow, conversation)) {
		return conversation;
	}

	const beforeEmergency = [...conversation];
	const result = compactToBudget({
		messages: conversation,
		contextWindow,
		promptTokens,
		promptChars,
		target: EMERGENCY_TARGET,
		type: "emergency",
		tools,
		sessionId,
		onReadFileCompacted,
		logger,
	});

	if (result.messages !== conversation) {
		if (logDir) {
			const scope = getScope() ?? "global";
			writeCompactionDump({
				logDir,
				before: beforeEmergency,
				afterCompaction: result.compacted,
				afterEviction: result.messages,
				code: "emg",
				scope,
				debug: logger?.level === "debug",
			});
		}
		return result.messages;
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
	reasoningDefaults?: ProviderOptions["reasoningDefaults"];
	contextWindow?: number;
	/** User-overridden context limit for display purposes (passed to provider stream). */
	contextLimit?: number | null;
	/** Stored prompt_tokens from the DB at turn start — used for a stable
	 *  charsPerToken ratio in emergency compaction (avoids oscillation from
	 *  live values that shift after each API call). */
	sessionPromptTokens?: number;
	/** Stored prompt_chars from the DB at turn start — paired with sessionPromptTokens. */
	sessionPromptChars?: number;
	/** Original uncompacted messages from DB, for emergency compaction input. */
	rawMessages?: Message[];
	logger?: Logger;
	logDir?: string;
	/** DB inode guard — throws DbDisconnectedError if the database file was replaced or deleted. */
	dbGuard?: DbGuard;
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

function cloneReasoningState(reasoning: ReasoningState): ReasoningState {
	switch (reasoning.kind) {
		case "responses-item":
			return { ...reasoning };
		case "interleaved-chat":
			return { ...reasoning };
		case "text-summary":
			return { ...reasoning };
	}
}

function applyReasoningDelta(reasoning: ReasoningState, delta: ReasoningDelta): ReasoningState {
	switch (delta.kind) {
		case "text":
			if (reasoning.kind === "interleaved-chat") {
				return { ...reasoning, text: (reasoning.text ?? "") + delta.text };
			}
			if (reasoning.kind === "text-summary") {
				return { ...reasoning, text: reasoning.text + delta.text };
			}
			return reasoning;
		case "details":
			if (reasoning.kind === "interleaved-chat") {
				return { ...reasoning, details: delta.details };
			}
			return reasoning;
		case "summary":
			if (reasoning.kind === "responses-item") {
				return { ...reasoning, summary: delta.summary };
			}
			return reasoning;
		case "encrypted-content":
			if (reasoning.kind === "responses-item") {
				return { ...reasoning, encryptedContent: delta.encryptedContent };
			}
			return reasoning;
	}
}

async function consumeProviderStream(
	stream: AsyncIterable<import("./provider/provider").StreamEvent>,
	onEvent: (event: AgentEvent) => void,
): Promise<{
	textContent: string;
	toolCalls: Map<number, AccumulatedToolCall>;
	reasoning: ReasoningState[] | undefined;
	finishReason: "stop" | "tool_calls";
}> {
	let textContent = "";
	const toolCalls = new Map<number, AccumulatedToolCall>();
	const reasoningAccumulator = createReasoningAccumulator();
	let finishReason: "stop" | "tool_calls" = "stop";

	for await (const event of stream) {
		switch (event.type) {
			case "text":
				textContent += event.text;
				onEvent({ type: "text", text: event.text });
				break;
			case "reasoning_start":
				reasoningAccumulator.active.set(event.index, cloneReasoningState(event.reasoning));
				break;
			case "reasoning_delta": {
				const reasoning = reasoningAccumulator.active.get(event.index);
				if (reasoning) {
					reasoningAccumulator.active.set(event.index, applyReasoningDelta(reasoning, event.delta));
				}
				break;
			}
			case "reasoning_end":
				endReasoning(reasoningAccumulator, event.index, event.reasoning);
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

	return {
		textContent,
		toolCalls,
		reasoning: consumeAccumulatedReasoning(reasoningAccumulator),
		finishReason,
	};
}

function finalizeReasoningState(current: ReasoningState, finalReasoning?: ReasoningState): ReasoningState {
	if (!finalReasoning) return current;
	if (finalReasoning.kind !== current.kind) return current;

	switch (current.kind) {
		case "responses-item":
			return { ...current, ...finalReasoning };
		case "interleaved-chat":
			return { ...current, ...finalReasoning };
		case "text-summary":
			return { ...current, ...finalReasoning };
	}
}

interface IndexedReasoningState {
	index: number;
	reasoning: ReasoningState;
}

interface ReasoningAccumulator {
	active: Map<number, ReasoningState>;
	completed: IndexedReasoningState[];
}

function createReasoningAccumulator(): ReasoningAccumulator {
	return {
		active: new Map<number, ReasoningState>(),
		completed: [],
	};
}

function pushCompletedReasoning(accumulator: ReasoningAccumulator, index: number, reasoning: ReasoningState): void {
	accumulator.completed.push({ index, reasoning: cloneReasoningState(reasoning) });
}

function endReasoning(accumulator: ReasoningAccumulator, index: number, finalReasoning?: ReasoningState): void {
	const activeReasoning = accumulator.active.get(index);
	if (activeReasoning) {
		pushCompletedReasoning(accumulator, index, finalizeReasoningState(activeReasoning, finalReasoning));
		accumulator.active.delete(index);
		if (finalReasoning && finalReasoning.kind !== activeReasoning.kind) {
			pushCompletedReasoning(accumulator, index, finalReasoning);
		}
		return;
	}
	if (finalReasoning) {
		pushCompletedReasoning(accumulator, index, finalReasoning);
	}
}

function consumeAccumulatedReasoning(accumulator: ReasoningAccumulator): ReasoningState[] | undefined {
	if (accumulator.active.size > 0) {
		for (const [index, reasoning] of accumulator.active.entries()) {
			pushCompletedReasoning(accumulator, index, reasoning);
		}
		accumulator.active.clear();
	}
	if (accumulator.completed.length === 0) return undefined;
	const reasoning = accumulator.completed
		.sort((left, right) => left.index - right.index)
		.map((item) => cloneReasoningState(item.reasoning));
	accumulator.completed.length = 0;
	return reasoning;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<Message[]> {
	const {
		provider,
		model,
		tools,
		projectRoot,
		accessibleDirectories,
		sessionId,
		onEvent,
		onMessage,
		signal,
		initiator,
		reasoningDefaults,
	} = options;
	const configDir = provider.configDir;
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new Error(`Invalid maxIterations: ${maxIterations}. Must be a positive integer.`);
	}

	// Working copy of messages — starts with what was passed in
	const conversation = [...options.messages];
	// New messages produced by this loop (what we return)
	const newMessages: Message[] = [];

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		// Check if the database file was replaced or deleted
		options.dbGuard?.assertConnected();
		// Abort if the signal has been triggered (e.g. WebSocket closed)
		signal?.throwIfAborted();

		const { textContent, toolCalls, reasoning, finishReason } = await consumeProviderStream(
			provider.stream({
				model,
				messages: conversation,
				tools: tools.definitions.length > 0 ? tools.definitions : undefined,
				signal,
				initiator,
				reasoningDefaults,
				contextLimit: options.contextLimit,
			}),
			onEvent,
		);

		if (finishReason === "stop" || toolCalls.size === 0) {
			// Normal text response — done
			const assistantMsg: AssistantMessage = {
				role: "assistant",
				content: textContent,
				reasoning,
			};
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

		const normalizedToolCallContent = textContent.trim().length > 0 ? textContent : null;
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: normalizedToolCallContent,
			tool_calls: toolCallContents,
			reasoning,
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

				const resultMap = new Map<string, ParallelResult>();

				const promises = group.items.map(async (tc): Promise<void> => {
					let args: Record<string, unknown>;
					try {
						args = JSON.parse(tc.function.arguments);
					} catch {
						args = {};
					}
					const tool = tools.get(tc.function.name);
					let result: ParallelResult;
					if (!tool) {
						result = {
							tc,
							llmOutput: `Unknown tool: ${tc.function.name}`,
							uiOutput: `Unknown tool: ${tc.function.name}`,
							mergeable: false,
						};
					} else {
						try {
							const isolated = createIsolatedTurnProvider(provider, configDir);
							const execResult = await tool.execute(args, {
								projectRoot,
								accessibleDirectories,
								sessionId,
								toolCallId: tc.id,
								provider: isolated,
							});
							result = {
								tc,
								llmOutput: execResult.llmOutput,
								uiOutput: execResult.uiOutput,
								mergeable: execResult.mergeable,
								summary: execResult.summary,
								resultMetadata: execResult.metadata,
							};
						} catch (err) {
							result = {
								tc,
								llmOutput: `Tool execution error: ${(err as Error).message}`,
								uiOutput: `Tool execution error: ${(err as Error).message}`,
								mergeable: false,
							};
						}
					}

					resultMap.set(tc.id, result);

					// Emit UI event immediately so the user sees each task's
					// status bar as soon as it completes (not after all finish).
					onEvent({
						type: "tool_result",
						id: tc.id,
						output: result.uiOutput,
						mergeable: result.mergeable,
						summary: result.summary,
						metadata: result.resultMetadata,
					});
				});

				await Promise.all(promises);

				// Inject conversation messages in dispatch order (deterministic for LLM + DB)
				for (const tc of group.items) {
					const r = resultMap.get(tc.id) as ParallelResult;
					const toolMsg: ToolMessage = { role: "tool", content: r.llmOutput, tool_call_id: tc.id };
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
							const result = await tool.execute(args, {
								projectRoot,
								accessibleDirectories,
								sessionId,
								toolCallId: tc.id,
								provider,
							});
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
					options.dbGuard?.assertConnected();
					signal?.throwIfAborted();
				}
			}

			// Check abort between groups
			options.dbGuard?.assertConnected();
			signal?.throwIfAborted();
		}

		// Emergency compaction: if content exceeds the character budget, compact from raw data before next iteration.
		// Uses the session's stored prompt_tokens/prompt_chars (from DB at turn start) for a stable
		// charsPerToken ratio. Live provider values shift after each API call (compacted vs uncompacted
		// payloads produce different ratios), causing budget oscillation and pressure flip-flopping.
		if (options.contextWindow && options.contextWindow > 0 && options.rawMessages) {
			const emgPromptTokens = options.sessionPromptTokens ?? 0;
			const emgPromptChars = options.sessionPromptChars ?? 0;
			const rawPlusNew = [...options.rawMessages, ...newMessages];

			if (shouldEmergencyCompact(emgPromptTokens, emgPromptChars, options.contextWindow, rawPlusNew)) {
				const result = compactToBudget({
					messages: rawPlusNew,
					contextWindow: options.contextWindow,
					promptTokens: emgPromptTokens,
					promptChars: emgPromptChars,
					target: COMPACTION_OUTPUT_TARGET,
					type: "emergency",
					tools,
					sessionId: options.sessionId,
					onReadFileCompacted: options.onReadFileCompacted,
					logger: options.logger,
				});

				if (result.messages !== rawPlusNew) {
					if (options.logDir) {
						const scope = getScope() ?? "global";
						writeCompactionDump({
							logDir: options.logDir,
							before: rawPlusNew,
							afterCompaction: result.compacted,
							afterEviction: result.messages,
							code: "emg",
							scope,
							debug: options.logger?.level === "debug",
						});
					}
					conversation.length = 0;
					conversation.push(...result.messages);
					setSnapshot(options.sessionId, {
						compactedMessages: result.messages,
						rawMessageCount: options.rawMessages.length + newMessages.length,
						snapshotChars: totalContentChars(result.messages),
					});
				}
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

	const { textContent: finalText, reasoning: finalReasoning } = await consumeProviderStream(
		provider.stream({
			model,
			messages: conversation,
			signal,
			initiator,
			reasoningDefaults,
			contextLimit: options.contextLimit,
		}),
		onEvent,
	);

	const finalMsg: AssistantMessage = {
		role: "assistant",
		content: finalText,
		reasoning: finalReasoning,
	};
	conversation.push(finalMsg);
	newMessages.push(finalMsg);
	onMessage(finalMsg);
	return newMessages;
}
