import type { ViewMode } from "./commandParser";
import { fuzzyFilterAndSort, VIEW_MODES } from "./commandParser";
import type { ModelListItem } from "./DotCommandPanel";
import type { StagedSkill, SubagentInfo } from "./protocol";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type PostResult =
	| {
			ok: true;
			status?: string;
			sessionId?: string;
			provider?: string;
			model?: string;
			contextLimit?: number | null;
			messages?: { text: string; kind: "info" | "success" | "error" }[];
	  }
	| { ok: false; error?: string };

function postDotCommand(
	command: string,
	args: string,
	sessionId: string | null,
	onSuccess: (result: PostResult & { ok: true }) => void,
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void,
): void {
	fetch("/bobai/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ command, args, sessionId }),
	})
		.then((res) => res.json())
		.then((result: PostResult) => {
			if (result.ok) {
				onSuccess(result);
			} else {
				addVolatileMessage(result.error ?? "Command failed", "error");
			}
		})
		.catch(() => {
			addVolatileMessage("Failed to execute command", "error");
		});
}

/**
 * Resolve an arg against a list by numeric index or fuzzy text search.
 * Returns the matching item or undefined.
 */
function resolveByIndexOrFuzzy<T extends { index: number }>(
	list: T[],
	arg: string,
	getSearchText: (item: T) => string,
): T | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;
	const firstToken = trimmed.split(/\s+/)[0] ?? "";
	if (/^\d+$/.test(firstToken)) {
		return list.find((item) => item.index === Number.parseInt(firstToken, 10));
	}
	return fuzzyFilterAndSort(list, trimmed, getSearchText)[0];
}

// ---------------------------------------------------------------------------
// handleNewCommand
// ---------------------------------------------------------------------------

export function handleNewCommand(params: {
	newChat: () => void;
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	setStatus: (status: string) => void;
	defaultStatus: string;
	setProvider: (provider: string | null) => void;
	defaultProvider: string | null;
	setModel: (model: string | null) => void;
	defaultModel: string | null;
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
	setTitle: (title: string | null) => void;
	pendingNewTitle: React.MutableRefObject<string | null>;
	setWelcomeMarkdown: (md: string | null) => void;
	newTitle: string;
}): void {
	params.newChat();
	params.setStagedSkills([]);
	params.setStatus(params.defaultStatus);
	params.setProvider(params.defaultProvider);
	params.setModel(params.defaultModel);
	params.setView((prev) => ({ ...prev, mode: "chat" }));
	if (params.newTitle) {
		params.setTitle(params.newTitle);
		params.pendingNewTitle.current = params.newTitle;
	}
	fetch("/bobai/welcome")
		.then((res) => res.json())
		.then((data: { markdown: string }) => {
			if (data?.markdown) params.setWelcomeMarkdown(data.markdown);
		})
		.catch(() => {});
}

// ---------------------------------------------------------------------------
// handleViewCommand
// ---------------------------------------------------------------------------

export function handleViewCommand(params: {
	arg: string;
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
	fetchContext: () => void;
	fetchCompactedContext: () => void;
	scrollToBottom: () => void;
}): void {
	const viewMap: Record<string, ViewMode> = { "1": "chat", "2": "context", "3": "compaction" };
	params.setView((prev) => {
		const currentIdx = VIEW_MODES.indexOf(prev.mode);
		const next = params.arg ? (viewMap[params.arg] ?? prev.mode) : (VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length] ?? "chat");
		if (next === "context") params.fetchContext();
		if (next === "compaction") params.fetchCompactedContext();
		return { ...prev, mode: next };
	});
	requestAnimationFrame(() => params.scrollToBottom());
}

// ---------------------------------------------------------------------------
// handleModelCommand
// ---------------------------------------------------------------------------

export function handleModelCommand(params: {
	args: string;
	currentProvider: string | null;
	modelListProvider: string | null;
	modelList: ModelListItem[] | null;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setProvider: (id: string) => void;
	setModel: (id: string | null) => void;
	setStatus: (status: string) => void;
	setContextLimit: (cl: number | null) => void;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
}): void {
	if (!params.currentProvider) {
		params.addVolatileMessage("Select a provider before selecting a model", "error");
		return;
	}
	const currentModelList = params.modelListProvider === params.currentProvider ? params.modelList : null;
	const resolvedModel = currentModelList ? resolveByIndexOrFuzzy(currentModelList, params.args, (m) => m.id) : undefined;
	const firstToken = (params.args ?? "").trim().split(/\s+/)[0] ?? "";
	const isNumeric = /^\d+$/.test(firstToken);

	if (currentModelList && params.args.trim() && !resolvedModel && !isNumeric) {
		params.addVolatileMessage(`No model matching "${params.args}"`, "error");
		return;
	}

	const submittedArgs = resolvedModel ? String(resolvedModel.index) : params.args;

	postDotCommand(
		"model",
		submittedArgs,
		params.getSessionId(),
		(result) => {
			params.clearVolatileMessages();
			if (result.sessionId) params.setSessionId(result.sessionId);
			if (result.provider) params.setProvider(result.provider);
			const selectedModel =
				result.model ??
				(resolvedModel ?? (currentModelList ? resolveByIndexOrFuzzy(currentModelList, submittedArgs, (m) => m.id) : undefined))
					?.id;
			if (result.model) {
				params.setModel(result.model);
			} else if (selectedModel) {
				params.setModel(selectedModel);
			}
			if (result.status) params.setStatus(result.status);
			if (selectedModel) {
				params.setContextLimit(null);
				const effectiveProvider = result.provider ?? params.currentProvider;
				if (effectiveProvider) {
					params.addVolatileMessage(`Using ${effectiveProvider} ${selectedModel} model`, "info");
				}
			}
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleProviderCommand
// ---------------------------------------------------------------------------

export function handleProviderCommand(params: {
	args: string;
	currentProvider: string | null;
	providerList: { index: number; id: string; runtimeSupported: boolean }[] | null;
	modelList: ModelListItem[] | null;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setProvider: (id: string) => void;
	setModel: (id: string | null) => void;
	setStatus: (status: string) => void;
	setContextLimit: (cl: number | null) => void;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
}): void {
	const resolvedProvider = params.providerList
		? resolveByIndexOrFuzzy(params.providerList, params.args, (p) => p.id)
		: undefined;
	const firstToken = (params.args ?? "").trim().split(/\s+/)[0] ?? "";
	const isNumeric = /^\d+$/.test(firstToken);

	if (params.providerList && params.args.trim() && !resolvedProvider && !isNumeric) {
		params.addVolatileMessage(`No provider matching "${params.args}"`, "error");
		return;
	}

	const submittedArgs = resolvedProvider ? String(resolvedProvider.index) : params.args;

	postDotCommand(
		"provider",
		submittedArgs,
		params.getSessionId(),
		(result) => {
			params.clearVolatileMessages();
			if (result.sessionId) params.setSessionId(result.sessionId);
			if (result.provider) {
				params.setProvider(result.provider);
				params.setModel(null);
				params.setContextLimit(null);
			}
			if (result.status) params.setStatus(result.status);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleTitleCommand
// ---------------------------------------------------------------------------

export function handleTitleCommand(params: {
	args: string;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setTitle: (title: string | null) => void;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
}): void {
	postDotCommand(
		"title",
		params.args,
		params.getSessionId(),
		(result) => {
			params.clearVolatileMessages();
			if (result.sessionId) params.setSessionId(result.sessionId);
			params.setTitle(params.args);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleLimitCommand
// ---------------------------------------------------------------------------

export function handleLimitCommand(params: {
	args: string;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setStatus: (status: string) => void;
	setContextLimit: (cl: number | null) => void;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
}): void {
	postDotCommand(
		"limit",
		params.args,
		params.getSessionId(),
		(result) => {
			params.clearVolatileMessages();
			if (result.sessionId) params.setSessionId(result.sessionId);
			if (result.status) params.setStatus(result.status);
			params.setContextLimit(result.contextLimit ?? null);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleSessionCommand
// ---------------------------------------------------------------------------

export function handleSessionCommand(params: {
	arg: string;
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null;
	getSessionId: () => string | null;
	loadSession: (id: string) => void;
	newChat: () => void;
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	setStatus: (status: string) => void;
	defaultStatus: string;
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
}): void {
	if (!params.arg) return;
	if (!params.sessionList) {
		params.addVolatileMessage("Session list not loaded", "error");
		return;
	}

	const parts = params.arg.split(/\s+/);
	const firstWord = parts[0] ?? "";
	const isNumeric = /^\d+$/.test(firstWord);

	if (!isNumeric) {
		const matches = fuzzyFilterAndSort(
			params.sessionList.filter((s) => s.title),
			params.arg,
			(s) => s.title ?? "",
		);
		if (matches.length === 0) {
			params.addVolatileMessage(`No session matching "${params.arg}"`, "error");
			return;
		}
		const currentId = params.getSessionId();
		const first = matches[0] as (typeof matches)[0];
		if (first.id === currentId) return;
		if (first.owned) {
			params.addVolatileMessage("Session is active in another tab", "error");
			return;
		}
		params.loadSession(first.id);
		params.setStagedSkills([]);
		params.setView((prev) => ({ ...prev, mode: "chat" }));
		return;
	}

	const index = Number.parseInt(firstWord, 10);
	const subcommand = parts[1];
	const targetSession = params.sessionList.find((s) => s.index === index);
	if (!targetSession) {
		params.addVolatileMessage(`Invalid session index: ${firstWord}`, "error");
		return;
	}

	if (subcommand) {
		if (subcommand !== "delete") {
			params.addVolatileMessage(`Unknown subcommand: ${subcommand}`, "error");
			return;
		}
		const isTargetSelf = targetSession.id === params.getSessionId();
		if (targetSession.owned && !isTargetSelf) {
			params.addVolatileMessage("Cannot delete: session is active in another tab", "error");
			return;
		}
		if (isTargetSelf) {
			params.newChat();
			params.setStagedSkills([]);
			params.setStatus(params.defaultStatus);
			params.setView((prev) => ({ ...prev, mode: "chat" }));
		}
		fetch(`/bobai/session/${targetSession.id}`, { method: "DELETE" })
			.then((res) => res.json())
			.then((data: { ok: boolean; id?: string; title?: string | null; error?: string }) => {
				if (data.ok) {
					const label = data.title ? `${data.id} "${data.title}"` : (data.id ?? targetSession.id);
					params.addVolatileMessage(`Session ${label} has been removed`, "success");
				} else {
					params.addVolatileMessage(data.error ?? "Failed to delete session", "error");
				}
			})
			.catch(() => {
				params.addVolatileMessage("Failed to delete session", "error");
			});
		return;
	}

	if (targetSession.id === params.getSessionId()) return;
	if (targetSession.owned) {
		params.addVolatileMessage("Session is active in another tab", "error");
		return;
	}
	params.loadSession(targetSession.id);
	params.setStagedSkills([]);
	params.setView((prev) => ({ ...prev, mode: "chat" }));
}

// ---------------------------------------------------------------------------
// handleSubagentCommand
// ---------------------------------------------------------------------------

export function handleSubagentCommand(params: {
	arg: string;
	subagentList: { index: number; title: string; sessionId: string }[] | null;
	subagents: SubagentInfo[];
	peekSubagentWithScroll: (sessionId: string) => void;
	peekSubagentFromDbWithScroll: (sessionId: string) => void;
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
}): void {
	if (!params.arg) return;
	if (!params.subagentList) {
		params.addVolatileMessage("Subagent list not loaded", "error");
		return;
	}
	const targetSubagent = resolveByIndexOrFuzzy(params.subagentList, params.arg, (s) => s.title);
	if (!targetSubagent) {
		const isNumeric = /^\d+$/.test(params.arg.trim().split(/\s+/)[0] ?? "");
		params.addVolatileMessage(
			isNumeric ? `Invalid subagent index: ${params.arg}` : `No subagent matching "${params.arg}"`,
			"error",
		);
		return;
	}
	const liveSubagent = params.subagents.find((s) => s.sessionId === targetSubagent.sessionId && s.status === "running");
	if (liveSubagent) {
		params.peekSubagentWithScroll(liveSubagent.sessionId);
	} else {
		params.peekSubagentFromDbWithScroll(targetSubagent.sessionId);
	}
	params.setStagedSkills([]);
}

// ---------------------------------------------------------------------------
// handleConfigurationCommand
// ---------------------------------------------------------------------------

export function handleConfigurationCommand(params: {
	command: string;
	args: string;
	getSessionId: () => string | null;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
	setResolvedDefaultProvider?: (provider: string) => void;
}): void {
	postDotCommand(
		params.command,
		params.args,
		params.getSessionId(),
		(result) => {
			params.clearVolatileMessages();
			if (result.messages) {
				for (const msg of result.messages) {
					params.addVolatileMessage(msg.text, msg.kind);
				}
			}
			// When the provider field changes, update the configured provider state
			// so the config tree's model list re-fetches for the new provider.
			if (result.provider) {
				params.setResolvedDefaultProvider?.(result.provider);
			}
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleSessionShortcut
// ---------------------------------------------------------------------------

export function handleSessionShortcut(params: {
	viewingSubagentId: string | null;
	exitSubagentPeekWithScroll: () => void;
	parentId: string | null;
	loadSession: (id: string) => void;
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
}): void {
	if (params.viewingSubagentId) {
		params.exitSubagentPeekWithScroll();
		params.setStagedSkills([]);
	} else if (params.parentId) {
		params.loadSession(params.parentId);
		params.setStagedSkills([]);
		params.setView((prev) => ({ ...prev, mode: "chat" }));
	}
}

// ---------------------------------------------------------------------------
// handleSlashCommand
// ---------------------------------------------------------------------------

export function handleSlashCommand(params: {
	name: string;
	stagedSkills: StagedSkill[];
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
}): void {
	if (params.stagedSkills.some((s) => s.name === params.name)) return;
	fetch("/bobai/skill", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: params.name }),
	})
		.then((res) => {
			if (!res.ok) return;
			return res.json();
		})
		.then((data) => {
			if (!data) return;
			params.setStagedSkills((prev) => [...prev, { name: data.name, content: data.content }]);
			params.addVolatileMessage(`▸ Staging ${data.name} skill`, "info");
		})
		.catch(() => {});
}
