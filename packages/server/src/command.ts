import type { Database } from "bun:sqlite";
import { buildSortedProviderModelList, formatProviderModelDisplay } from "./provider/models";
import { DEFAULT_PROVIDER_ID, type ProviderId } from "./provider/providers";
import { createSession, getSession, listSubagentSessions, updateSessionModel, updateSessionTitle } from "./session/repository";

export interface CommandRequest {
	command: string;
	args: string;
	sessionId?: string;
}

export interface CommandOptions {
	providerId?: ProviderId;
	configDir?: string;
}

export type CommandResult = { ok: true; status?: string; sessionId?: string } | { ok: false; error: string };

export function handleCommand(db: Database, req: CommandRequest, options: CommandOptions = {}): CommandResult {
	const { command, args } = req;
	let { sessionId } = req;

	// Create a session on the fly if none exists yet
	if (!sessionId) {
		const session = createSession(db);
		sessionId = session.id;
	} else {
		const session = getSession(db, sessionId);
		if (!session) {
			return { ok: false, error: `Session not found: ${sessionId}` };
		}
	}

	const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
	const configDir = options.configDir;

	switch (command) {
		case "model":
			return withSessionId(handleModelCommand(db, sessionId, args, { providerId, configDir }), sessionId);
		case "title":
			return withSessionId(handleTitleCommand(db, sessionId, args), sessionId);
		case "subagent":
			return withSessionId(handleSubagentCommand(db, sessionId), sessionId);
		case "session":
			return { ok: true, sessionId };
		default:
			return { ok: false, error: `Unknown command: ${command}` };
	}
}

function withSessionId(result: CommandResult, sessionId: string): CommandResult {
	if (result.ok) {
		return { ...result, sessionId };
	}
	return result;
}

function handleModelCommand(
	db: Database,
	sessionId: string,
	args: string,
	options: { providerId: ProviderId; configDir?: string },
): CommandResult {
	const sortedModels = buildSortedProviderModelList(options.providerId, options.configDir);
	const index = Number.parseInt(args, 10);
	if (Number.isNaN(index) || index < 1 || index > sortedModels.length) {
		return { ok: false, error: `Invalid model index: ${args}` };
	}
	const modelId = sortedModels[index - 1]?.id;
	if (!modelId) {
		return { ok: false, error: `Invalid model index: ${args}` };
	}
	updateSessionModel(db, sessionId, modelId);
	const session = getSession(db, sessionId);
	const promptTokens = session?.promptTokens ?? 0;
	return {
		ok: true,
		status: formatProviderModelDisplay(options.providerId, modelId, promptTokens, options.configDir),
	};
}

function handleSubagentCommand(db: Database, sessionId: string): CommandResult {
	// Session existence already validated by handleCommand
	const session = getSession(db, sessionId);
	if (!session) return { ok: false, error: "Session not found" };
	const parentId = session.parentId ?? sessionId;
	const subagents = listSubagentSessions(db, parentId);
	if (subagents.length === 0) {
		return { ok: true, status: "No subagent sessions" };
	}
	const lines = subagents.map((s, i) => `${i + 1}: ${s.title ?? "(untitled)"}`).join("\n");
	return { ok: true, status: lines };
}

function handleTitleCommand(db: Database, sessionId: string, args: string): CommandResult {
	const title = args.trim();
	if (!title) {
		return { ok: false, error: "Title cannot be empty" };
	}
	updateSessionTitle(db, sessionId, title);
	return { ok: true };
}
