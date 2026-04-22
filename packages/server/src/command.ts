import type { Database } from "bun:sqlite";
import {
	getApiFamilyForModel,
	getDefaultSessionBackend,
	type SessionBackendState,
	validateModelSwitch,
	validateProviderSwitch,
} from "./provider/backend-policy";
import { buildSortedProviderModelList, formatProviderModelDisplay } from "./provider/models";
import { type AuthProviderId, DEFAULT_PROVIDER_ID, type ProviderId } from "./provider/providers";
import {
	countSessionMessages,
	createSession,
	getSession,
	listSubagentSessions,
	updateSessionBackend,
	updateSessionTitle,
} from "./session/repository";

export interface CommandRequest {
	command: string;
	args: string;
	sessionId?: string;
}

export interface CommandOptions {
	defaultProviderId?: ProviderId;
	configDir?: string;
	listAuthenticatedProviders?: () => { index: number; id: AuthProviderId; runtimeSupported: boolean }[];
}

export type CommandResult =
	| { ok: true; status?: string; sessionId?: string; provider?: string; model?: string }
	| { ok: false; error: string };

export function handleCommand(db: Database, req: CommandRequest, options: CommandOptions = {}): CommandResult {
	const { command, args } = req;
	let { sessionId } = req;
	const defaultProviderId = options.defaultProviderId ?? DEFAULT_PROVIDER_ID;

	// Create a session on the fly if none exists yet
	if (!sessionId) {
		const backend = getDefaultSessionBackend(defaultProviderId);
		const session = createSession(db, {
			provider: backend.provider,
			model: backend.model,
			apiFamily: backend.apiFamily,
		});
		sessionId = session.id;
	} else {
		const session = getSession(db, sessionId);
		if (!session) {
			return { ok: false, error: `Session not found: ${sessionId}` };
		}
	}

	switch (command) {
		case "model":
			return withSessionId(
				handleModelCommand(db, sessionId, args, { defaultProviderId, configDir: options.configDir }),
				sessionId,
			);
		case "provider":
			return withSessionId(
				handleProviderCommand(db, sessionId, args, {
					defaultProviderId,
					configDir: options.configDir,
					listAuthenticatedProviders: options.listAuthenticatedProviders,
				}),
				sessionId,
			);
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

function resolveSessionBackend(db: Database, sessionId: string, defaultProviderId: ProviderId): SessionBackendState | null {
	const session = getSession(db, sessionId);
	if (!session) return null;
	const provider = (session.provider as ProviderId | null) ?? defaultProviderId;
	const model = session.model ?? getDefaultSessionBackend(provider).model;
	const apiFamily = session.apiFamily ?? getApiFamilyForModel(provider, model);
	return { provider, model, apiFamily };
}

function handleModelCommand(
	db: Database,
	sessionId: string,
	args: string,
	options: { defaultProviderId: ProviderId; configDir?: string },
): CommandResult {
	const current = resolveSessionBackend(db, sessionId, options.defaultProviderId);
	if (!current) return { ok: false, error: "Session not found" };

	const sortedModels = buildSortedProviderModelList(current.provider, options.configDir);
	const index = Number.parseInt(args, 10);
	if (Number.isNaN(index) || index < 1 || index > sortedModels.length) {
		return { ok: false, error: `Invalid model index: ${args}` };
	}
	const modelId = sortedModels[index - 1]?.id;
	if (!modelId) {
		return { ok: false, error: `Invalid model index: ${args}` };
	}

	const transition = validateModelSwitch({
		hasMessages: countSessionMessages(db, sessionId) > 0,
		current,
		nextModel: modelId,
	});
	if (!transition.ok) {
		return transition;
	}

	updateSessionBackend(db, sessionId, transition.next);
	const session = getSession(db, sessionId);
	const promptTokens = session?.promptTokens ?? 0;
	return {
		ok: true,
		provider: transition.next.provider,
		model: transition.next.model,
		status: formatProviderModelDisplay(transition.next.provider, transition.next.model, promptTokens, options.configDir),
	};
}

function handleProviderCommand(
	db: Database,
	sessionId: string,
	args: string,
	options: {
		defaultProviderId: ProviderId;
		configDir?: string;
		listAuthenticatedProviders?: () => { index: number; id: AuthProviderId; runtimeSupported: boolean }[];
	},
): CommandResult {
	const providers = options.listAuthenticatedProviders?.() ?? [];
	const index = Number.parseInt(args, 10);
	if (Number.isNaN(index) || index < 1 || index > providers.length) {
		return { ok: false, error: `Invalid provider index: ${args}` };
	}
	const selected = providers[index - 1];
	if (!selected) {
		return { ok: false, error: `Invalid provider index: ${args}` };
	}
	if (!selected.runtimeSupported) {
		return { ok: false, error: `Provider runtime is not supported yet: ${selected.id}` };
	}

	const current = resolveSessionBackend(db, sessionId, options.defaultProviderId);
	if (!current) return { ok: false, error: "Session not found" };

	const transition = validateProviderSwitch({
		hasMessages: countSessionMessages(db, sessionId) > 0,
		current,
		nextProvider: selected.id as ProviderId,
	});
	if (!transition.ok) {
		return transition;
	}

	updateSessionBackend(db, sessionId, transition.next);
	const session = getSession(db, sessionId);
	const promptTokens = session?.promptTokens ?? 0;
	return {
		ok: true,
		provider: transition.next.provider,
		model: transition.next.model,
		status: formatProviderModelDisplay(transition.next.provider, transition.next.model, promptTokens, options.configDir),
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
