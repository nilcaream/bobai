import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../agent-loop";
import { runAgentLoop } from "../agent-loop";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { compactMessages } from "../compaction/engine";
import { evictOldTurns } from "../compaction/eviction";
import { FileTime } from "../file/time";
import type { InstructionFile } from "../instructions";
import type { Logger } from "../log/logger";
import { runWithScope } from "../log/logger";
import { subagentScope } from "../log/session-tag";
import { loadModelsConfig } from "../provider/copilot-models";
import type { AssistantMessage, Message, Provider } from "../provider/provider";
import { appendMessage, createSubagentSession, getMessages, getSession, updateMessageMetadata } from "../session/repository";
import type { SkillRegistry } from "../skill/skill";
import type { SubagentStatus } from "../subagent-status";
import { buildSystemPrompt } from "../system-prompt";
import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { fileSearchTool } from "./file-search";
import { grepSearchTool } from "./grep-search";
import { listDirectoryTool } from "./list-directory";
import { readFileTool } from "./read-file";
import { createSkillTool } from "./skill";
import { sqlite3Tool } from "./sqlite3";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { createToolRegistry } from "./tool";
import { writeFileTool } from "./write-file";

function formatTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface TaskToolDeps {
	db: Database;
	provider: Provider;
	model: string;
	parentSessionId: string;
	projectRoot: string;
	accessibleDirectories?: string[];
	skills: SkillRegistry;
	instructions: InstructionFile[];
	maxIterations?: number;
	signal?: AbortSignal;
	onEvent: (event: AgentEvent & { sessionId?: string }) => void;
	sendWs?: (msg: import("../protocol").ServerMessage) => void;
	subagentStatus: SubagentStatus;
	logger?: Logger;
	logDir?: string;
}

export function createTaskTool(deps: TaskToolDeps): Tool {
	const {
		db,
		provider,
		model,
		parentSessionId,
		projectRoot,
		accessibleDirectories,
		skills,
		instructions,
		signal,
		onEvent,
		sendWs,
		subagentStatus,
		logger,
		logDir,
	} = deps;

	return {
		definition: {
			type: "function",
			function: {
				name: "task",
				description:
					"Launch a subagent to handle a complex, multi-step task autonomously. " +
					"The subagent runs its own agent loop with full tool access (except task). " +
					"For exploratory/read-only tasks, instruct the subagent to avoid edit_file and write_file. " +
					"Each subagent starts fresh — include all necessary context in the prompt. " +
					"Returns the subagent's final response text and a task_id for potential resumption.",
				parameters: {
					type: "object",
					properties: {
						description: {
							type: "string",
							description: "Session title — one sentence describing what the subagent should accomplish",
						},
						prompt: {
							type: "string",
							description: "Full instructions for the subagent including all necessary context",
						},
						task_id: {
							type: "string",
							description: "Resume a previous subagent session (optional)",
						},
					},
					required: ["description", "prompt"],
				},
			},
		},
		mergeable: false,
		outputThreshold: 0.8,
		argsThreshold: 0.8,
		compact(output: string, callArgs: Record<string, unknown>, context?: { sessionId: string; toolCallId: string }): string {
			if (context) {
				const dir = path.join(".bobai", "compaction", context.sessionId);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, `${context.toolCallId}.md`), output);
			}
			const description = typeof callArgs.description === "string" ? callArgs.description : "?";
			const filePath = context
				? `.bobai/compaction/${context.sessionId}/${context.toolCallId}.md`
				: ".bobai/compaction/<unknown>.md";
			return `${COMPACTION_MARKER} task(${JSON.stringify({ description })}) output saved to ${filePath} — use read_file to see full result.`;
		},
		compactArgs(args: Record<string, unknown>): Record<string, unknown> {
			const result = { ...args };
			if (typeof result.prompt === "string") result.prompt = COMPACTION_MARKER;
			return result;
		},
		formatCall(args: Record<string, unknown>): string {
			return `▸ ${args.description ?? "task"}`;
		},
		async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
			const activeProvider = _ctx.provider ?? provider;
			const description = args.description as string;
			const prompt = args.prompt as string;
			const taskId = args.task_id as string | undefined;

			let childSessionId: string;

			if (taskId) {
				// Resume existing session — validate it exists and is a subagent
				const existing = getSession(db, taskId);
				if (!existing) {
					return {
						llmOutput: `Error: session "${taskId}" not found. Cannot resume a non-existent subagent.`,
						uiOutput: null,
						mergeable: false,
					};
				}
				if (!existing.parentId) {
					return {
						llmOutput: `Error: session "${taskId}" is not a subagent session. Cannot resume.`,
						uiOutput: null,
						mergeable: false,
					};
				}
				childSessionId = taskId;
			} else {
				// Create child session with description as title
				const child = createSubagentSession(db, parentSessionId, description, model);
				childSessionId = child.id;

				// Add the task prompt as a user message with agent metadata
				appendMessage(db, childSessionId, "user", prompt, {
					source: "agent",
					parentSessionId,
				});
			}

			const scope = subagentScope(parentSessionId, childSessionId);
			const childLogger = logger?.withScope(scope);

			// Emit initial prompt as prompt_echo for the child session
			// so the UI can display it when peeking at the subagent
			sendWs?.({ type: "prompt_echo", text: prompt, sessionId: childSessionId });

			// Notify status tracker
			subagentStatus.set(childSessionId, "running");
			onEvent({ type: "status", text: "Subagent started", sessionId: childSessionId });

			// Emit WebSocket lifecycle event
			if (sendWs) {
				const session = getSession(db, childSessionId);
				const toolCallId = _ctx.toolCallId ?? "";
				sendWs({ type: "subagent_start", sessionId: childSessionId, title: session?.title ?? description, toolCallId });
			}

			// Load child session messages
			const stored = getMessages(db, childSessionId);
			let messages: Message[] = stored
				// BACKWARD COMPAT: Sessions created before the dynamic system prompt change
				// stored a system message in the DB. Skip it — we always prepend a fresh one below.
				// Remove this filter once all legacy subagent sessions are gone.
				.filter((m) => m.role !== "system")
				.map((m) => {
					if (m.role === "tool" && m.metadata?.tool_call_id) {
						return { role: "tool" as const, content: m.content, tool_call_id: m.metadata.tool_call_id as string };
					}
					if (m.role === "assistant" && m.metadata?.tool_calls) {
						return {
							role: "assistant" as const,
							content: m.content || null,
							tool_calls: m.metadata.tool_calls as AssistantMessage["tool_calls"],
						};
					}
					return { role: m.role as "user" | "assistant", content: m.content };
				});

			// Prepend the dynamic system prompt (always fresh, reflects current skills/config)
			const subagentPrompt = buildSystemPrompt(skills.list(), instructions, { subagent: true });
			messages.unshift({ role: "system", content: subagentPrompt });

			// Build tool registry without the task tool itself (no recursion)
			const skillTool = createSkillTool(skills);
			const childTools = createToolRegistry([
				readFileTool,
				listDirectoryTool,
				fileSearchTool,
				writeFileTool,
				editFileTool,
				grepSearchTool,
				bashTool,
				sqlite3Tool,
				skillTool,
			]);

			// Compact old tool outputs for resumed subagent sessions.
			// New sessions have no tool messages yet, so this is a no-op.
			const childSession = getSession(db, childSessionId);
			const childPromptTokens = childSession?.promptTokens ?? 0;
			const childModelConfigs = loadModelsConfig();
			const childModelConfig = childModelConfigs.find((m) => m.id === model);
			const childContextWindow = childModelConfig?.contextWindow ?? 0;
			if (childContextWindow <= 0) {
				childLogger?.warn("CONFIG", `No contextWindow for model "${model}"; subagent compaction disabled`);
			}
			function invalidateCompactedRead(_toolCallId: string, callArgs: Record<string, unknown>) {
				const filePath = typeof callArgs.path === "string" ? callArgs.path : null;
				if (filePath) {
					const resolved = path.resolve(projectRoot, filePath);
					FileTime.invalidate(childSessionId, resolved);
				}
			}

			const rawMessages = [...messages];
			if (childContextWindow > 0 && childPromptTokens > 0) {
				messages = compactMessages({
					messages,
					context: { promptTokens: childPromptTokens, contextWindow: childContextWindow },
					tools: childTools,
					sessionId: childSessionId,
					onReadFileCompacted: invalidateCompactedRead,
				});
			}

			messages = evictOldTurns(messages);

			// Run agent loop with provider turn state isolation
			let newMessages: Message[];
			const parentState = activeProvider.saveTurnState?.();
			activeProvider.beginTurn?.(childPromptTokens);

			// Capture tool metadata from onEvent (same pattern as handler.ts)
			const toolMeta = new Map<
				string,
				{
					formatCall?: string;
					uiOutput?: string | null;
					mergeable?: boolean;
					summary?: string;
					resultMetadata?: Record<string, unknown>;
				}
			>();
			let lastAssistantMessageId: string | undefined;

			try {
				newMessages = await runWithScope(scope, () =>
					runAgentLoop({
						provider: activeProvider,
						model,
						messages,
						tools: childTools,
						projectRoot,
						accessibleDirectories,
						sessionId: childSessionId,
						maxIterations: deps.maxIterations,
						signal,
						initiator: "agent",
						contextWindow: childContextWindow,
						rawMessages,
						logger: childLogger,
						logDir,
						onReadFileCompacted: invalidateCompactedRead,
						onEvent(event: AgentEvent) {
							onEvent({ ...event, sessionId: childSessionId });
							if (event.type === "tool_call") {
								const existing = toolMeta.get(event.id) ?? {};
								toolMeta.set(event.id, { ...existing, formatCall: event.output });
							}
							if (event.type === "tool_result") {
								const existing = toolMeta.get(event.id) ?? {};
								toolMeta.set(event.id, {
									...existing,
									uiOutput: event.output,
									mergeable: event.mergeable ?? true,
									summary: event.summary,
									resultMetadata: event.metadata,
								});
							}
						},
						onMessage(msg) {
							if (msg.role === "assistant") {
								const assistantMsg = msg as AssistantMessage;
								const metadata = assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : undefined;
								const stored = appendMessage(db, childSessionId, "assistant", assistantMsg.content ?? "", metadata);
								lastAssistantMessageId = stored.id;
							} else if (msg.role === "tool") {
								const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
								const metadata: Record<string, unknown> = { tool_call_id: toolMsg.tool_call_id };
								const captured = toolMeta.get(toolMsg.tool_call_id);
								if (captured !== undefined) {
									if (captured.formatCall !== undefined) metadata.format_call = captured.formatCall;
									if (captured.uiOutput !== undefined) metadata.ui_output = captured.uiOutput;
									if (captured.mergeable !== undefined) metadata.mergeable = captured.mergeable;
									if (captured.summary) metadata.tool_summary = captured.summary;
									if (captured.resultMetadata) Object.assign(metadata, captured.resultMetadata);
									toolMeta.delete(toolMsg.tool_call_id);
								}
								appendMessage(db, childSessionId, "tool", toolMsg.content, metadata);
							}
						},
					}),
				);
			} catch (err) {
				subagentStatus.set(childSessionId, "error");
				sendWs?.({ type: "subagent_done", sessionId: childSessionId });
				const turnSummary = activeProvider.getTurnSummary?.() ?? "";
				if (parentState !== undefined) activeProvider.restoreTurnState?.(parentState);
				// Persist turn summary on last assistant message for reconstruction
				if (lastAssistantMessageId && turnSummary) {
					updateMessageMetadata(db, lastAssistantMessageId, { summary: turnSummary, turn_model: model });
				}
				const ts = formatTimestamp();
				return {
					llmOutput: `Subagent failed: ${(err as Error).message}\n\n[task_id: ${childSessionId}]`,
					uiOutput: null,
					mergeable: false,
					summary: turnSummary ? `${ts}${turnSummary} (error)` : undefined,
					metadata: { subagent_session_id: childSessionId },
				};
			}

			const turnSummary = activeProvider.getTurnSummary?.();
			if (parentState !== undefined) activeProvider.restoreTurnState?.(parentState);

			// Persist turn summary on last assistant message for reconstruction
			if (lastAssistantMessageId && (turnSummary || model)) {
				updateMessageMetadata(db, lastAssistantMessageId, {
					...(turnSummary ? { summary: turnSummary } : {}),
					turn_model: model,
				});
			}

			subagentStatus.set(childSessionId, "done");
			sendWs?.({ type: "subagent_done", sessionId: childSessionId });

			// Extract final assistant text
			const lastAssistant = [...newMessages]
				.reverse()
				.find((m) => m.role === "assistant" && !(m as AssistantMessage).tool_calls?.length);
			const resultText = lastAssistant ? (lastAssistant as { content: string }).content : "(subagent produced no text output)";

			const llmOutput = `${resultText}\n\n[task_id: ${childSessionId}]`;
			const ts = formatTimestamp();

			return {
				llmOutput,
				uiOutput: null,
				mergeable: false,
				summary: turnSummary ? `${ts}${turnSummary}` : undefined,
				metadata: { subagent_session_id: childSessionId },
			};
		},
	};
}
