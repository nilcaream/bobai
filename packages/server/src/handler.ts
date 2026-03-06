import type { Database } from "bun:sqlite";
import type { AgentEvent } from "./agent-loop";
import { runAgentLoop } from "./agent-loop";
import { send } from "./protocol";
import type { AssistantMessage, Message, Provider } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import {
	appendMessage,
	createSession,
	getMessages,
	getSession,
	updateMessageMetadata,
	updateSessionModel,
	updateSessionPromptTokens,
} from "./session/repository";
import { SubagentStatus } from "./subagent-status";
import { SYSTEM_PROMPT } from "./system-prompt";
import { bashTool } from "./tool/bash";
import { editFileTool } from "./tool/edit-file";
import { grepSearchTool } from "./tool/grep-search";
import { listDirectoryTool } from "./tool/list-directory";
import { readFileTool } from "./tool/read-file";
import { createTaskTool } from "./tool/task";
import { createToolRegistry } from "./tool/tool";
import { writeFileTool } from "./tool/write-file";

// TODO: Module-level singleton accumulates entries forever. Consider per-session scoping
// or adding cleanup when subagents complete. Acceptable for now since Task 9 uses DB-based listing.
const subagentStatus = new SubagentStatus();

export interface PromptRequest {
	ws: { send: (msg: string) => void };
	db: Database;
	provider: Provider;
	model: string;
	text: string;
	sessionId?: string;
	projectRoot: string;
}

function routeEventToWs(ws: { send: (msg: string) => void }, event: AgentEvent & { sessionId?: string }) {
	if (event.type === "text") {
		send(ws, { type: "token", text: event.text, sessionId: event.sessionId });
	} else if (event.type === "tool_call") {
		send(ws, { type: "tool_call", id: event.id, output: event.output, sessionId: event.sessionId });
	} else if (event.type === "tool_result") {
		send(ws, {
			type: "tool_result",
			id: event.id,
			output: event.output,
			mergeable: event.mergeable,
			summary: event.summary,
			sessionId: event.sessionId,
		});
	} else if (event.type === "status") {
		send(ws, { type: "status", text: event.text, sessionId: event.sessionId });
	}
}

export async function handlePrompt(req: PromptRequest) {
	const { ws, db, provider, model, text, sessionId, projectRoot } = req;

	let currentSessionId: string | undefined;
	let sessionObj: { model: string | null; title: string | null } | null = null;
	let effectiveModel = model;
	let lastAssistantMessageId: string | null = null;

	try {
		// Resolve or create session
		if (sessionId) {
			const session = getSession(db, sessionId);
			if (!session) {
				send(ws, { type: "error", message: `Session not found: ${sessionId}` });
				return;
			}
			currentSessionId = sessionId;
			sessionObj = session;
		} else {
			const session = createSession(db, SYSTEM_PROMPT);
			currentSessionId = session.id;
			sessionObj = session;
		}

		effectiveModel = sessionObj?.model ?? model;

		// Persist the effective model so session load can reconstruct the status bar
		if (!sessionObj?.model && currentSessionId) {
			updateSessionModel(db, currentSessionId, effectiveModel);
		}

		// Persist the user message
		appendMessage(db, currentSessionId, "user", text);

		// Load full conversation history and convert to Message[]
		const stored = getMessages(db, currentSessionId);
		const messages: Message[] = stored.map((m) => {
			if (m.role === "tool" && m.metadata?.tool_call_id) {
				return { role: "tool", content: m.content, tool_call_id: m.metadata.tool_call_id as string };
			}
			if (m.role === "assistant" && m.metadata?.tool_calls) {
				return {
					role: "assistant",
					content: m.content || null,
					tool_calls: m.metadata.tool_calls as AssistantMessage["tool_calls"],
				};
			}
			return { role: m.role as "system" | "user" | "assistant", content: m.content };
		});

		const taskTool = createTaskTool({
			db,
			provider,
			model: effectiveModel,
			parentSessionId: currentSessionId,
			projectRoot,
			systemPrompt: SYSTEM_PROMPT,
			onEvent(event) {
				routeEventToWs(ws, event);
			},
			sendWs: (msg) => send(ws, msg),
			subagentStatus,
		});

		const tools = createToolRegistry([
			readFileTool,
			listDirectoryTool,
			writeFileTool,
			editFileTool,
			grepSearchTool,
			bashTool,
			taskTool,
		]);

		// Signal the provider to start tracking turn stats
		provider.beginTurn?.();

		// Run the agent loop
		// Capture UI-formatted tool outputs from onEvent (fires before onMessage for the same tool call)
		const toolUiOutputs = new Map<string, string | null>();
		await runAgentLoop({
			provider,
			model: effectiveModel,
			messages,
			tools,
			projectRoot,
			onEvent(event: AgentEvent) {
				routeEventToWs(ws, event);
				if (event.type === "tool_result") {
					toolUiOutputs.set(event.id, event.output);
				}
			},
			onMessage(msg) {
				if (!currentSessionId) return;
				if (msg.role === "assistant") {
					const metadata = msg.tool_calls ? { tool_calls: msg.tool_calls } : undefined;
					const stored = appendMessage(db, currentSessionId, "assistant", msg.content ?? "", metadata);
					lastAssistantMessageId = stored.id;
				} else if (msg.role === "tool") {
					const metadata: Record<string, unknown> = { tool_call_id: msg.tool_call_id };
					const uiOutput = toolUiOutputs.get(msg.tool_call_id);
					if (uiOutput !== undefined) {
						metadata.ui_output = uiOutput;
						toolUiOutputs.delete(msg.tool_call_id);
					}
					appendMessage(db, currentSessionId, "tool", msg.content, metadata);
				}
			},
		});

		const summary = provider.getTurnSummary?.();
		const promptTokens = provider.getTurnPromptTokens?.() ?? 0;
		if (currentSessionId && promptTokens > 0) {
			updateSessionPromptTokens(db, currentSessionId, promptTokens);
		}
		if (lastAssistantMessageId && (summary || effectiveModel)) {
			updateMessageMetadata(db, lastAssistantMessageId, {
				...(summary ? { summary } : {}),
				turn_model: effectiveModel,
			});
		}
		send(ws, { type: "done", sessionId: currentSessionId, model: effectiveModel, title: sessionObj?.title ?? null, summary });
	} catch (err) {
		// Persist error as assistant message so agent can resume with context
		if (currentSessionId) {
			const errorText =
				err instanceof ProviderError
					? `[Error: Provider error (${err.status}): ${err.body}]`
					: `[Error: ${(err as Error).message}]`;
			const errorMsg = appendMessage(db, currentSessionId, "assistant", errorText);
			lastAssistantMessageId = errorMsg.id;
		}

		if (err instanceof ProviderError) {
			send(ws, { type: "error", message: `Provider error (${err.status}): ${err.body}` });
		} else {
			console.error("Unexpected error in handlePrompt:", err);
			send(ws, { type: "error", message: "Unexpected error during generation" });
		}

		// Send done so UI gets sessionId for resume
		if (currentSessionId) {
			const errSummary = provider.getTurnSummary?.();
			const errPromptTokens = provider.getTurnPromptTokens?.() ?? 0;
			if (errPromptTokens > 0) {
				updateSessionPromptTokens(db, currentSessionId, errPromptTokens);
			}
			if (lastAssistantMessageId && (errSummary || effectiveModel)) {
				updateMessageMetadata(db, lastAssistantMessageId, {
					...(errSummary ? { summary: errSummary } : {}),
					turn_model: effectiveModel,
				});
			}
			send(ws, {
				type: "done",
				sessionId: currentSessionId,
				model: effectiveModel,
				title: sessionObj?.title ?? null,
				summary: errSummary,
			});
		}
	}
}
