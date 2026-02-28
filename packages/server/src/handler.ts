import type { Database } from "bun:sqlite";
import type { AgentEvent } from "./agent-loop";
import { runAgentLoop } from "./agent-loop";
import { send } from "./protocol";
import type { AssistantMessage, Message, Provider } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import { appendMessage, createSession, getMessages, getSession } from "./session/repository";
import { SYSTEM_PROMPT } from "./system-prompt";
import { bashTool } from "./tool/bash";
import { editFileTool } from "./tool/edit-file";
import { grepSearchTool } from "./tool/grep-search";
import { listDirectoryTool } from "./tool/list-directory";
import { readFileTool } from "./tool/read-file";
import { createToolRegistry } from "./tool/tool";
import { writeFileTool } from "./tool/write-file";

export interface PromptRequest {
	ws: { send: (msg: string) => void };
	db: Database;
	provider: Provider;
	model: string;
	text: string;
	sessionId?: string;
	projectRoot: string;
}

export async function handlePrompt(req: PromptRequest) {
	const { ws, db, provider, model, text, sessionId, projectRoot } = req;

	let currentSessionId: string | undefined;

	try {
		// Resolve or create session
		if (sessionId) {
			const session = getSession(db, sessionId);
			if (!session) {
				send(ws, { type: "error", message: `Session not found: ${sessionId}` });
				return;
			}
			currentSessionId = sessionId;
		} else {
			const session = createSession(db, SYSTEM_PROMPT);
			currentSessionId = session.id;
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

		const tools = createToolRegistry([readFileTool, listDirectoryTool, writeFileTool, editFileTool, grepSearchTool, bashTool]);

		// Run the agent loop
		await runAgentLoop({
			provider,
			model,
			messages,
			tools,
			projectRoot,
			onEvent(event: AgentEvent) {
				if (event.type === "text") {
					send(ws, { type: "token", text: event.text });
				} else if (event.type === "tool_call") {
					send(ws, { type: "tool_call", id: event.id, name: event.name, arguments: event.arguments });
				} else if (event.type === "tool_result") {
					send(ws, { type: "tool_result", id: event.id, name: event.name, output: event.output, isError: event.isError });
				}
			},
			onMessage(msg) {
				if (!currentSessionId) return;
				if (msg.role === "assistant") {
					const metadata = msg.tool_calls ? { tool_calls: msg.tool_calls } : undefined;
					appendMessage(db, currentSessionId, "assistant", msg.content ?? "", metadata);
				} else if (msg.role === "tool") {
					appendMessage(db, currentSessionId, "tool", msg.content, { tool_call_id: msg.tool_call_id });
				}
			},
		});

		send(ws, { type: "done", sessionId: currentSessionId, model });
	} catch (err) {
		// Persist error as assistant message so agent can resume with context
		if (currentSessionId) {
			const errorText =
				err instanceof ProviderError
					? `[Error: Provider error (${err.status}): ${err.body}]`
					: `[Error: ${(err as Error).message}]`;
			appendMessage(db, currentSessionId, "assistant", errorText);
		}

		if (err instanceof ProviderError) {
			send(ws, { type: "error", message: `Provider error (${err.status}): ${err.body}` });
		} else {
			console.error("Unexpected error in handlePrompt:", err);
			send(ws, { type: "error", message: "Unexpected error during generation" });
		}

		// Send done so UI gets sessionId for resume
		if (currentSessionId) {
			send(ws, { type: "done", sessionId: currentSessionId, model });
		}
	}
}
