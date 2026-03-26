import type { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentEvent } from "./agent-loop";
import { runAgentLoop } from "./agent-loop";
import { writeCompactionDump } from "./compaction/dump";
import { compactMessages } from "./compaction/engine";
import { loadInstructions } from "./instructions";
import type { Logger } from "./log/logger";
import { repairMessageOrdering } from "./message-repair";
import type { StagedSkill } from "./protocol";
import { send } from "./protocol";
import { loadModelsConfig } from "./provider/copilot-models";
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
import type { SkillRegistry } from "./skill/skill";
import { SubagentStatus } from "./subagent-status";
import { buildSystemPrompt } from "./system-prompt";
import { bashTool } from "./tool/bash";
import { editFileTool } from "./tool/edit-file";
import { fileSearchTool } from "./tool/file-search";
import { grepSearchTool } from "./tool/grep-search";
import { listDirectoryTool } from "./tool/list-directory";
import { readFileTool } from "./tool/read-file";
import { createSkillTool } from "./tool/skill";
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
	configDir: string;
	skills: SkillRegistry;
	skillDirectories?: string[];
	stagedSkills?: StagedSkill[];
	logger?: Logger;
	logDir?: string;
	signal?: AbortSignal;
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
	const { ws, db, provider, model, text, sessionId, projectRoot, configDir, skills, skillDirectories, stagedSkills } = req;

	const instructions = loadInstructions(configDir, projectRoot);
	const systemPrompt = buildSystemPrompt(skills.list(), instructions);
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
			const session = createSession(db);
			currentSessionId = session.id;
			sessionObj = session;
		}

		effectiveModel = sessionObj?.model ?? model;

		// Persist the effective model so session load can reconstruct the status bar
		if (!sessionObj?.model && currentSessionId) {
			updateSessionModel(db, currentSessionId, effectiveModel);
		}

		// Persist staged skills as real tool call/result pairs BEFORE the user message
		// so they appear in the correct order in conversation history and survive reload.
		if (stagedSkills && stagedSkills.length > 0) {
			for (const staged of stagedSkills) {
				const toolCallId = crypto.randomUUID();
				const formatCall = `▸ Loading ${staged.name} skill`;
				const uiOutput = `▸ Loaded ${staged.name} skill`;
				const registeredSkill = skills.get(staged.name);
				const baseDirHint = registeredSkill
					? `\n\n---\nSource: ${registeredSkill.filePath}\nBase directory: ${path.dirname(registeredSkill.filePath)} (use to construct absolute paths when reading files referenced by this skill)`
					: "";
				const llmContent = `# Skill: ${staged.name}\n\n${staged.content}${baseDirHint}`;

				// Persist assistant message with tool_calls metadata
				appendMessage(db, currentSessionId, "assistant", "", {
					tool_calls: [
						{
							id: toolCallId,
							type: "function",
							function: { name: "skill", arguments: JSON.stringify({ name: staged.name }) },
						},
					],
				});

				// Persist tool result message
				appendMessage(db, currentSessionId, "tool", llmContent, {
					tool_call_id: toolCallId,
					format_call: formatCall,
					ui_output: uiOutput,
					mergeable: true,
				});

				// Emit events for live UI rendering
				routeEventToWs(ws, { type: "tool_call", id: toolCallId, output: formatCall });
				routeEventToWs(ws, { type: "tool_result", id: toolCallId, output: uiOutput, mergeable: true });
			}

			// Send prompt_echo so client adds user message after skill panels
			send(ws, { type: "prompt_echo", text });
		}

		// Persist the user message
		appendMessage(db, currentSessionId, "user", text);

		// Load full conversation history and convert to Message[]
		const stored = getMessages(db, currentSessionId);
		let messages: Message[] = stored
			// BACKWARD COMPAT: Sessions created before the dynamic system prompt change
			// stored the system message in the DB at sort_order 0. Skip it — we always
			// prepend a fresh one below. Remove this filter once all legacy sessions are gone.
			.filter((m) => m.role !== "system")
			.map((m) => {
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
				return { role: m.role as "user" | "assistant", content: m.content };
			});

		// Repair any message ordering issues from interrupted or concurrent agent loops
		const repair = repairMessageOrdering(messages);
		if (repair.repaired) {
			messages = repair.messages;
			console.warn(`[message-repair] Repaired message ordering in session ${currentSessionId}`);
		}

		// Prepend the dynamic system prompt (always fresh, reflects current skills/config)
		messages.unshift({ role: "system", content: systemPrompt });

		const taskTool = createTaskTool({
			db,
			provider,
			model: effectiveModel,
			parentSessionId: currentSessionId,
			projectRoot,
			accessibleDirectories: skillDirectories,
			systemPrompt,
			logger: req.logger,
			logDir: req.logDir,
			onEvent(event) {
				routeEventToWs(ws, event);
			},
			sendWs: (msg) => send(ws, msg),
			subagentStatus,
		});

		const skillTool = createSkillTool(skills);

		const tools = createToolRegistry([
			readFileTool,
			listDirectoryTool,
			fileSearchTool,
			writeFileTool,
			editFileTool,
			grepSearchTool,
			bashTool,
			taskTool,
			skillTool,
		]);

		// Compact old/irrelevant tool outputs before sending to the LLM.
		// Uses the session's last known prompt token count and the model's context window.
		const currentSession = getSession(db, currentSessionId);
		const sessionPromptTokens = currentSession?.promptTokens ?? 0;
		const modelConfigs = loadModelsConfig();
		const modelConfig = modelConfigs.find((m) => m.id === effectiveModel);
		const contextWindow = modelConfig?.contextWindow ?? 0;
		const rawMessages = [...messages];
		if (contextWindow > 0 && sessionPromptTokens > 0) {
			const beforeCompaction = messages;
			messages = compactMessages({
				messages,
				context: { promptTokens: sessionPromptTokens, contextWindow },
				tools,
			});
			// Write debug dump if compaction actually changed something
			if (messages !== beforeCompaction && req.logDir) {
				const { preFile } = writeCompactionDump(req.logDir, beforeCompaction, messages, "pre-prompt");
				if (preFile && req.logger) {
					req.logger.debug("COMPACTION", `pre-prompt dump: ${preFile}`);
				}
			}
		}

		// Signal the provider to start tracking turn stats
		provider.beginTurn?.();

		// Run the agent loop
		// Capture tool metadata from onEvent (fires before onMessage for the same tool call)
		const toolMeta = new Map<
			string,
			{ formatCall?: string; uiOutput?: string | null; mergeable?: boolean; summary?: string }
		>();
		await runAgentLoop({
			provider,
			model: effectiveModel,
			messages,
			tools,
			projectRoot,
			accessibleDirectories: skillDirectories,
			contextWindow,
			rawMessages,
			logger: req.logger,
			logDir: req.logDir,
			signal: req.signal,
			onEvent(event: AgentEvent) {
				routeEventToWs(ws, event);
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
					});
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
					const captured = toolMeta.get(msg.tool_call_id);
					if (captured !== undefined) {
						if (captured.formatCall !== undefined) metadata.format_call = captured.formatCall;
						if (captured.uiOutput !== undefined) metadata.ui_output = captured.uiOutput;
						if (captured.mergeable !== undefined) metadata.mergeable = captured.mergeable;
						if (captured.summary) metadata.tool_summary = captured.summary;
						toolMeta.delete(msg.tool_call_id);
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
		// Abort errors (e.g. WebSocket closed) are not real failures — don't persist error message
		const isAbort = err instanceof DOMException && err.name === "AbortError";

		if (!isAbort) {
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
		}

		// Send done so UI gets sessionId (even on abort — needed for session continuity)
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
