import type { Database } from "bun:sqlite";
import { formatConfig } from "./config/display";
import { updateGlobalConfig, updateProjectConfig } from "./config/write";
import {
	getApiFamilyForModel,
	getDefaultSessionBackend,
	type SessionBackendState,
	validateModelSwitch,
	validateProviderSwitch,
} from "./provider/backend-policy";
import { buildSortedProviderModelList, formatProviderModelDisplay } from "./provider/models";
import type { AuthProviderId, ProviderId } from "./provider/providers";
import {
	clearSessionContextLimit,
	countSessionMessages,
	createSession,
	getSession,
	updateSessionBackend,
	updateSessionContextLimit,
	updateSessionTitle,
} from "./session/repository";

export interface CommandRequest {
	command: string;
	args: string;
	sessionId?: string;
}

export interface CommandOptions {
	defaultProviderId?: ProviderId | null;
	defaultModel?: string | null;
	configDir?: string;
	listAuthenticatedProviders?: () => { index: number; id: AuthProviderId; runtimeSupported: boolean }[];
	projectRoot?: string;
	projectConfig?: { debug?: boolean; port?: number; provider?: string; model?: string; maxIterations?: number };
	globalConfig?: { debug?: boolean; port?: number; provider?: string; model?: string; maxIterations?: number };
}

export type CommandResult =
	| {
			ok: true;
			status?: string;
			sessionId?: string;
			provider?: string;
			model?: string;
			contextLimit?: number | null;
			messages?: { text: string; kind: "info" | "success" | "error" }[];
	  }
	| { ok: false; error: string };

export function handleCommand(db: Database, req: CommandRequest, options: CommandOptions = {}): CommandResult {
	const { command, args } = req;
	let { sessionId } = req;
	const defaultProviderId = options.defaultProviderId ?? null;
	const defaultModel = options.defaultModel ?? null;

	// Create a session on the fly if none exists yet (skip for configuration command)
	if (!sessionId && command !== "configuration") {
		const backend = resolveConfiguredSessionBackend(defaultProviderId, defaultModel);
		const session = createSession(
			db,
			backend
				? {
						provider: backend.provider,
						model: backend.model,
						apiFamily: backend.apiFamily,
					}
				: undefined,
		);
		sessionId = session.id;
	} else if (sessionId) {
		const session = getSession(db, sessionId);
		if (!session) {
			return { ok: false, error: `Session not found: ${sessionId}` };
		}
	}

	switch (command) {
		case "model":
			return withSessionId(
				handleModelCommand(db, sessionId, args, { defaultProviderId, defaultModel, configDir: options.configDir }),
				sessionId,
			);
		case "provider":
			return withSessionId(
				handleProviderCommand(db, sessionId, args, {
					defaultProviderId,
					defaultModel,
					configDir: options.configDir,
					listAuthenticatedProviders: options.listAuthenticatedProviders,
				}),
				sessionId,
			);
		case "title":
			return withSessionId(handleTitleCommand(db, sessionId, args), sessionId);
		case "limit":
			return withSessionId(
				handleLimitCommand(db, sessionId, args, { defaultProviderId, defaultModel, configDir: options.configDir }),
				sessionId,
			);
		case "configuration":
			return handleConfigurationCommand(args, options);
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

function resolveConfiguredSessionBackend(
	defaultProviderId: ProviderId | null,
	defaultModel: string | null,
): SessionBackendState | null {
	if (!defaultProviderId) return null;
	if (!defaultModel) return getDefaultSessionBackend(defaultProviderId);
	return {
		provider: defaultProviderId,
		model: defaultModel,
		apiFamily: getApiFamilyForModel(defaultProviderId, defaultModel),
	};
}

function resolveSessionBackend(
	db: Database,
	sessionId: string,
	defaultProviderId: ProviderId | null,
	defaultModel: string | null,
): SessionBackendState | null {
	const session = getSession(db, sessionId);
	if (!session) return null;
	const provider = (session.provider as ProviderId | null) ?? defaultProviderId;
	const model = session.model ?? defaultModel;
	if (!provider || !model) return null;
	const apiFamily = session.apiFamily ?? getApiFamilyForModel(provider, model);
	return { provider, model, apiFamily };
}

function handleModelCommand(
	db: Database,
	sessionId: string,
	args: string,
	options: { defaultProviderId: ProviderId | null; defaultModel: string | null; configDir?: string },
): CommandResult {
	const existingSession = getSession(db, sessionId);
	if (!existingSession) return { ok: false, error: "Session not found" };
	if (!existingSession.provider && !options.defaultProviderId) {
		return { ok: false, error: "Select a provider before selecting a model" };
	}
	const current = resolveSessionBackend(db, sessionId, options.defaultProviderId, options.defaultModel);
	if (!current) return { ok: false, error: "Provider or model not selected" };

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
		defaultProviderId: ProviderId | null;
		defaultModel: string | null;
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

	const hasMessages = countSessionMessages(db, sessionId) > 0;
	const current = resolveSessionBackend(db, sessionId, options.defaultProviderId, options.defaultModel);
	const transition = current
		? validateProviderSwitch({
				hasMessages,
				current,
				nextProvider: selected.id as ProviderId,
			})
		: hasMessages
			? { ok: false, error: "Changing provider for a session with messages is not yet supported." }
			: { ok: true, next: getDefaultSessionBackend(selected.id as ProviderId) };
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

function handleTitleCommand(db: Database, sessionId: string, args: string): CommandResult {
	const title = args.trim();
	if (!title) {
		return { ok: false, error: "Title cannot be empty" };
	}
	updateSessionTitle(db, sessionId, title);
	return { ok: true };
}

function handleLimitCommand(
	db: Database,
	sessionId: string,
	args: string,
	options: { defaultProviderId: ProviderId | null; defaultModel: string | null; configDir?: string },
): CommandResult {
	const trimmed = args.trim();
	const session = getSession(db, sessionId);
	if (!session) return { ok: false, error: "Session not found" };

	if (!trimmed) {
		// Remove limit
		clearSessionContextLimit(db, sessionId);
		const backend = resolveSessionBackend(db, sessionId, options.defaultProviderId, options.defaultModel);
		if (!backend) return { ok: true, contextLimit: null };
		const promptTokens = session.promptTokens;
		return {
			ok: true,
			contextLimit: null,
			status: formatProviderModelDisplay(backend.provider, backend.model, promptTokens, options.configDir),
		};
	}

	// Parse number, optionally with "k" suffix
	const match = trimmed.match(/^(\d+)(k)?$/i);
	if (!match) {
		return { ok: false, error: `Invalid limit: "${trimmed}". Use a number like 10000 or 10k` };
	}
	const value = Number.parseInt(match[1] as string, 10) * (match[2] ? 1000 : 1);
	if (value <= 0) {
		return { ok: false, error: "Limit must be greater than 0" };
	}

	updateSessionContextLimit(db, sessionId, value);
	const backend = resolveSessionBackend(db, sessionId, options.defaultProviderId, options.defaultModel);
	if (!backend) return { ok: true, contextLimit: value };
	const promptTokens = session.promptTokens;
	return {
		ok: true,
		contextLimit: value,
		status: formatProviderModelDisplay(backend.provider, backend.model, promptTokens, options.configDir, value),
	};
}

// ---------------------------------------------------------------------------
// Configuration command
// ---------------------------------------------------------------------------

const SCOPES = ["project", "global"] as const;
type ConfigScope = (typeof SCOPES)[number];

const FIELDS = ["debug", "provider", "model", "port", "maxIterations"] as const;
type ConfigField = (typeof FIELDS)[number];

function resolveScope(token: string): ConfigScope | null {
	const lower = token.toLowerCase();
	const matches = SCOPES.filter((s) => s.toLowerCase().startsWith(lower));
	return matches.length === 1 ? (matches[0] as ConfigScope) : null;
}

function resolveField(token: string): ConfigField | null {
	const lower = token.toLowerCase();
	const matches = FIELDS.filter((f) => f.toLowerCase().startsWith(lower));
	return matches.length === 1 ? (matches[0] as ConfigField) : null;
}

function formatScopeError(token: string): string {
	const lower = token.toLowerCase();
	const matches = SCOPES.filter((s) => s.toLowerCase().startsWith(lower));
	if (matches.length > 1) {
		return `Ambiguous scope: "${token}". Did you mean ${matches.map((s) => `"${s}"`).join(" or ")}?`;
	}
	return `Unknown scope: "${token}". Use "project" or "global".`;
}

function formatFieldError(token: string): string {
	const lower = token.toLowerCase();
	const matches = FIELDS.filter((f) => f.toLowerCase().startsWith(lower));
	if (matches.length > 1) {
		return `Ambiguous field: "${token}". Did you mean ${matches.map((f) => `"${f}"`).join(" or ")}?`;
	}
	return `Unknown field: "${token}". Valid fields: ${FIELDS.join(", ")}.`;
}

function mergeEffectiveConfig(
	project: CommandOptions["projectConfig"],
	global: CommandOptions["globalConfig"],
): Record<string, unknown> {
	return {
		debug: project?.debug ?? global?.debug,
		port: project?.port ?? global?.port,
		provider: project?.provider ?? global?.provider,
		model: project?.model ?? global?.model,
		maxIterations: project?.maxIterations ?? global?.maxIterations,
	};
}

function validateConfigValue(
	field: ConfigField,
	rawValue: string,
	options: CommandOptions,
): { ok: true; value: unknown } | { ok: false; error: string } {
	switch (field) {
		case "debug": {
			const lower = rawValue.toLowerCase();
			if (!lower) return { ok: false, error: `Invalid value for debug: "${rawValue}". Use "true" or "false".` };
			if ("true".startsWith(lower)) return { ok: true, value: true };
			if ("false".startsWith(lower)) return { ok: true, value: false };
			return { ok: false, error: `Invalid value for debug: "${rawValue}". Use "true" or "false".` };
		}
		case "port": {
			const num = Number(rawValue);
			if (!Number.isInteger(num) || num < 1 || num > 65535) {
				return { ok: false, error: `Invalid port: "${rawValue}". Must be an integer between 1 and 65535.` };
			}
			return { ok: true, value: num };
		}
		case "maxIterations": {
			const num = Number(rawValue);
			if (!Number.isInteger(num) || num < 1) {
				return { ok: false, error: `Invalid maxIterations: "${rawValue}". Must be a positive integer.` };
			}
			return { ok: true, value: num };
		}
		case "provider": {
			const providers = options.listAuthenticatedProviders?.() ?? [];
			// Try numeric index first
			if (/^\d+$/.test(rawValue)) {
				const idx = Number.parseInt(rawValue, 10);
				const provider = providers.find((p) => p.index === idx);
				if (!provider) return { ok: false, error: `Invalid provider index: ${rawValue}` };
				if (!provider.runtimeSupported) {
					return { ok: false, error: `Provider runtime is not supported yet: ${provider.id}` };
				}
				return { ok: true, value: provider.id };
			}
			// Try exact match
			const exact = providers.find((p) => p.id === rawValue);
			if (exact) {
				if (!exact.runtimeSupported) {
					return { ok: false, error: `Provider runtime is not supported yet: ${exact.id}` };
				}
				return { ok: true, value: exact.id };
			}
			// Try prefix match
			const prefixMatches = providers.filter((p) => p.id.startsWith(rawValue));
			if (prefixMatches.length === 1 && prefixMatches[0]) {
				if (!prefixMatches[0].runtimeSupported) {
					return { ok: false, error: `Provider runtime is not supported yet: ${prefixMatches[0].id}` };
				}
				return { ok: true, value: prefixMatches[0].id };
			}
			if (prefixMatches.length > 1) {
				return { ok: false, error: `Ambiguous provider: "${rawValue}".` };
			}
			return { ok: false, error: `Unknown provider: "${rawValue}".` };
		}
		case "model": {
			const configDir = options.configDir;
			if (!configDir) return { ok: false, error: "Config directory not available" };

			// Determine which provider to validate against
			const projectCfg = options.projectConfig;
			const globalCfg = options.globalConfig;
			const provider = projectCfg?.provider ?? globalCfg?.provider;
			if (!provider) {
				return { ok: false, error: "Set a provider before setting a model" };
			}

			const models = buildSortedProviderModelList(provider as ProviderId, configDir);

			// Try numeric index
			if (/^\d+$/.test(rawValue)) {
				const idx = Number.parseInt(rawValue, 10);
				const model = models.find((m) => m.index === idx);
				if (!model) return { ok: false, error: `Invalid model index: ${rawValue}` };
				return { ok: true, value: model.id };
			}
			// Try exact match
			const exact = models.find((m) => m.id === rawValue);
			if (exact) return { ok: true, value: exact.id };
			// Try prefix match
			const prefixMatches = models.filter((m) => m.id.startsWith(rawValue));
			if (prefixMatches.length === 1 && prefixMatches[0]) {
				return { ok: true, value: prefixMatches[0].id };
			}
			if (prefixMatches.length > 1) {
				return { ok: false, error: `Ambiguous model: "${rawValue}".` };
			}
			return { ok: false, error: `Unknown model: "${rawValue}".` };
		}
	}
}

function handleConfigurationCommand(args: string, options: CommandOptions): CommandResult {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	// Case 1: bare .configuration — show effective config
	if (tokens.length === 0) {
		const effective = mergeEffectiveConfig(options.projectConfig, options.globalConfig);
		const display = formatConfig(effective, "effective");
		return { ok: true, messages: [{ text: display, kind: "info" }] };
	}

	// Case 2: resolve scope
	const scopeToken = tokens[0] as string;
	const scope = resolveScope(scopeToken);
	if (!scope) {
		return { ok: false, error: formatScopeError(scopeToken) };
	}

	// Case 3: scope only — show config for that scope
	if (tokens.length === 1) {
		const config = scope === "project" ? options.projectConfig : options.globalConfig;
		const display = formatConfig((config as Record<string, unknown>) ?? {}, scope);
		return { ok: true, messages: [{ text: display, kind: "info" }] };
	}

	// Case 4: resolve field
	const fieldToken = tokens[1] as string;
	const field = resolveField(fieldToken);
	if (!field) {
		return { ok: false, error: formatFieldError(fieldToken) };
	}

	// Case 5: field only — show current value
	if (tokens.length === 2) {
		const config = scope === "project" ? options.projectConfig : options.globalConfig;
		const value = config?.[field as keyof typeof config] ?? "(not set)";
		return { ok: true, messages: [{ text: `${field} = ${value}`, kind: "info" }] };
	}

	// Case 6: set value
	const rawValue = tokens.slice(2).join(" ");
	const validated = validateConfigValue(field, rawValue, options);
	if (!validated.ok) return validated;

	// Write config
	try {
		if (scope === "project") {
			if (!options.projectRoot) return { ok: false, error: "Project root not available" };
			updateProjectConfig(options.projectRoot, { [field]: validated.value });
		} else {
			if (!options.configDir) return { ok: false, error: "Config directory not available" };
			updateGlobalConfig(options.configDir, { [field]: validated.value });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to update config: ${message}` };
	}

	return {
		ok: true,
		messages: [{ text: `${scope} ${field} = ${validated.value}`, kind: "success" }],
	};
}
