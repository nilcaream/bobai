import type { Database } from "bun:sqlite";
import { CURATED_MODELS, formatModelStatus } from "./provider/copilot-models";
import { createSession, getSession, updateSessionModel, updateSessionTitle } from "./session/repository";
import { SYSTEM_PROMPT } from "./system-prompt";

export interface CommandRequest {
	command: string;
	args: string;
	sessionId?: string;
}

export type CommandResult = { ok: true; status?: string; sessionId?: string } | { ok: false; error: string };

export function handleCommand(db: Database, req: CommandRequest): CommandResult {
	const { command, args } = req;
	let { sessionId } = req;

	// Create a session on the fly if none exists yet
	if (!sessionId) {
		const session = createSession(db, SYSTEM_PROMPT);
		sessionId = session.id;
	} else {
		const session = getSession(db, sessionId);
		if (!session) {
			return { ok: false, error: `Session not found: ${sessionId}` };
		}
	}

	switch (command) {
		case "model":
			return withSessionId(handleModelCommand(db, sessionId, args), sessionId);
		case "title":
			return withSessionId(handleTitleCommand(db, sessionId, args), sessionId);
		case "session":
			return { ok: false, error: "Session switching is not implemented yet" };
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

function handleModelCommand(db: Database, sessionId: string, args: string): CommandResult {
	const index = Number.parseInt(args, 10);
	if (Number.isNaN(index) || index < 1 || index > CURATED_MODELS.length) {
		return { ok: false, error: `Invalid model index: ${args}. Must be 1-${CURATED_MODELS.length}` };
	}
	const modelId = CURATED_MODELS[index - 1];
	updateSessionModel(db, sessionId, modelId);
	return { ok: true, status: formatModelStatus(modelId) };
}

function handleTitleCommand(db: Database, sessionId: string, args: string): CommandResult {
	const title = args.trim();
	if (!title) {
		return { ok: false, error: "Title cannot be empty" };
	}
	updateSessionTitle(db, sessionId, title);
	return { ok: true };
}
