import type { Database } from "bun:sqlite";
import type { AgentEvent } from "../agent-loop";
import { runAgentLoop } from "../agent-loop";
import type { AssistantMessage, Message, Provider } from "../provider/provider";
import { appendMessage, createSubagentSession, getMessages } from "../session/repository";
import type { SubagentStatus } from "../subagent-status";
import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { grepSearchTool } from "./grep-search";
import { listDirectoryTool } from "./list-directory";
import { readFileTool } from "./read-file";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { createToolRegistry } from "./tool";
import { writeFileTool } from "./write-file";

export interface TaskToolDeps {
	db: Database;
	provider: Provider;
	model: string;
	parentSessionId: string;
	projectRoot: string;
	systemPrompt: string;
	signal?: AbortSignal;
	onEvent: (event: AgentEvent & { sessionId?: string }) => void;
	subagentStatus: SubagentStatus;
}

async function generateTitle(provider: Provider, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
	const messages: Message[] = [
		{
			role: "user",
			content: `Generate a short title (3-8 words) for this task. Return ONLY the title, nothing else.\n\nTask: ${prompt}`,
		},
	];

	let title = "";
	for await (const event of provider.stream({ model, messages, signal })) {
		if (event.type === "text") {
			title += event.text;
		}
	}
	return title.trim().replace(/^["']|["']$/g, "");
}

export function createTaskTool(deps: TaskToolDeps): Tool {
	const { db, provider, model, parentSessionId, projectRoot, systemPrompt, signal, onEvent, subagentStatus } = deps;

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
				// Resume existing session
				childSessionId = taskId;
			} else {
				// Generate title, fall back to description
				let title: string;
				try {
					title = await generateTitle(provider, model, prompt, signal);
					if (!title) title = description;
				} catch {
					title = description;
				}

				// Create child session
				const child = createSubagentSession(db, parentSessionId, title, model, systemPrompt);
				childSessionId = child.id;

				// Add the task prompt as a user message with agent metadata
				appendMessage(db, childSessionId, "user", prompt, {
					source: "agent",
					parentSessionId,
				});
			}

			// Notify status tracker
			subagentStatus.set(childSessionId, "running");
			onEvent({ type: "status", text: "Subagent started", sessionId: childSessionId });

			// Load child session messages
			const stored = getMessages(db, childSessionId);
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

			// Run agent loop
			const newMessages = await runAgentLoop({
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

			subagentStatus.set(childSessionId, "done");

			// Extract final assistant text
			const lastAssistant = [...newMessages].reverse().find((m) => m.role === "assistant" && !("tool_calls" in m));
			const resultText = lastAssistant ? (lastAssistant as { content: string }).content : "(subagent produced no text output)";

			const llmOutput = `${resultText}\n\n[task_id: ${childSessionId}]`;

			return {
				llmOutput,
				uiOutput: null,
				mergeable: false,
			};
		},
	};
}
