import type { Database } from "bun:sqlite";
import type { AgentEvent } from "../agent-loop";
import { runAgentLoop } from "../agent-loop";
import type { AssistantMessage, Message, Provider } from "../provider/provider";
import { appendMessage, createSubagentSession, getMessages, getSession } from "../session/repository";
import type { SubagentStatus } from "../subagent-status";
import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { grepSearchTool } from "./grep-search";
import { listDirectoryTool } from "./list-directory";
import { readFileTool } from "./read-file";
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
	systemPrompt: string;
	signal?: AbortSignal;
	onEvent: (event: AgentEvent & { sessionId?: string }) => void;
	sendWs?: (msg: import("../protocol").ServerMessage) => void;
	subagentStatus: SubagentStatus;
}

interface TitleResult {
	title: string;
	userPrompt: string;
}

async function generateTitle(provider: Provider, model: string, prompt: string, signal?: AbortSignal): Promise<TitleResult> {
	const truncatedPrompt = prompt.length > 1000 ? `${prompt.slice(0, 1000)}...\n\n(truncated)` : prompt;
	const userPrompt = `Generate a short title (1 sentence, up to 20 words) for this task. Return ONLY the title, nothing else.\n\nTask: ${truncatedPrompt}`;
	const messages: Message[] = [{ role: "user", content: userPrompt }];

	let title = "";
	for await (const event of provider.stream({ model, messages, signal, initiator: "agent" })) {
		if (event.type === "text") {
			title += event.text;
		}
	}
	return { title: title.trim().replace(/^["']|["']$/g, ""), userPrompt };
}

export function createTaskTool(deps: TaskToolDeps): Tool {
	const { db, provider, model, parentSessionId, projectRoot, systemPrompt, signal, onEvent, sendWs, subagentStatus } = deps;

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
							description: "Short task description (up to 20 words)",
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
		formatCall(args: Record<string, unknown>): string {
			return `**Subagent** ${args.description ?? "task"}`;
		},
		async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
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
				// Generate title, fall back to description
				let title: string;
				let titleGenExchange: { userPrompt: string; assistantResponse: string } | undefined;
				try {
					const result = await generateTitle(provider, "gpt-5-mini", prompt, signal);
					title = result.title || description;
					titleGenExchange = { userPrompt: result.userPrompt, assistantResponse: result.title };
				} catch {
					title = description;
				}

				// Create child session
				const child = createSubagentSession(db, parentSessionId, title, model, systemPrompt);
				childSessionId = child.id;

				// Persist title generation exchange if available
				if (titleGenExchange) {
					appendMessage(db, childSessionId, "user", titleGenExchange.userPrompt, {
						purpose: "title-generation",
					});
					appendMessage(db, childSessionId, "assistant", titleGenExchange.assistantResponse, {
						purpose: "title-generation",
					});
				}

				// Add the task prompt as a user message with agent metadata
				appendMessage(db, childSessionId, "user", prompt, {
					source: "agent",
					parentSessionId,
				});
			}

			// Notify status tracker
			subagentStatus.set(childSessionId, "running");
			onEvent({ type: "status", text: "Subagent started", sessionId: childSessionId });

			// Emit WebSocket lifecycle event
			if (sendWs) {
				const session = getSession(db, childSessionId);
				sendWs({ type: "subagent_start", sessionId: childSessionId, title: session?.title ?? description });
			}

			// Load child session messages, excluding title-generation exchanges
			const stored = getMessages(db, childSessionId).filter((m) => m.metadata?.purpose !== "title-generation");
			const messages: Message[] = stored.map((m) => {
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
				return { role: m.role as "system" | "user" | "assistant", content: m.content };
			});

			// Build tool registry without the task tool itself (no recursion)
			const childTools = createToolRegistry([
				readFileTool,
				listDirectoryTool,
				writeFileTool,
				editFileTool,
				grepSearchTool,
				bashTool,
			]);

			// Run agent loop with provider turn state isolation
			let newMessages: Message[];
			const parentState = provider.saveTurnState?.();
			provider.beginTurn?.();
			try {
				newMessages = await runAgentLoop({
					provider,
					model,
					messages,
					tools: childTools,
					projectRoot,
					signal,
					initiator: "agent",
					onEvent(event: AgentEvent) {
						onEvent({ ...event, sessionId: childSessionId });
					},
					onMessage(msg) {
						if (msg.role === "assistant") {
							const assistantMsg = msg as AssistantMessage;
							const metadata = assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : undefined;
							appendMessage(db, childSessionId, "assistant", assistantMsg.content ?? "", metadata);
						} else if (msg.role === "tool") {
							const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
							appendMessage(db, childSessionId, "tool", toolMsg.content, { tool_call_id: toolMsg.tool_call_id });
						}
					},
				});
			} catch (err) {
				subagentStatus.set(childSessionId, "error");
				sendWs?.({ type: "subagent_done", sessionId: childSessionId });
				const turnSummary = provider.getTurnSummary?.() ?? "";
				if (parentState !== undefined) provider.restoreTurnState?.(parentState);
				const ts = formatTimestamp();
				return {
					llmOutput: `Subagent failed: ${(err as Error).message}\n\n[task_id: ${childSessionId}]`,
					uiOutput: null,
					mergeable: false,
					summary: turnSummary ? `${ts}${turnSummary} (error)` : undefined,
				};
			}

			const turnSummary = provider.getTurnSummary?.();
			if (parentState !== undefined) provider.restoreTurnState?.(parentState);

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
			};
		},
	};
}
