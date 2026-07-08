import type { DotCommandResult, ViewMode } from "./commandParser";
import { VIEW_MODES } from "./commandParser";
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

// ---------------------------------------------------------------------------
// handleNewCommand
// ---------------------------------------------------------------------------

export function handleNewCommand(
	result: { title: string },
	params: {
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
	},
): void {
	params.newChat();
	params.setStagedSkills([]);
	params.setStatus(params.defaultStatus);
	params.setProvider(params.defaultProvider);
	params.setModel(params.defaultModel);
	params.setView((prev) => ({ ...prev, mode: "chat" }));
	if (result.title) {
		params.setTitle(result.title);
		params.pendingNewTitle.current = result.title;
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

export function handleViewCommand(
	result: { arg: string },
	params: {
		setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
		fetchContext: () => void;
		fetchCompactedContext: () => void;
		scrollToBottom: () => void;
	},
): void {
	const viewMap: Record<string, ViewMode> = { "1": "chat", "2": "context", "3": "compaction" };
	params.setView((prev) => {
		const currentIdx = VIEW_MODES.indexOf(prev.mode);
		const next = result.arg ? (viewMap[result.arg] ?? prev.mode) : (VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length] ?? "chat");
		if (next === "context") params.fetchContext();
		if (next === "compaction") params.fetchCompactedContext();
		return { ...prev, mode: next };
	});
	requestAnimationFrame(() => params.scrollToBottom());
}

// ---------------------------------------------------------------------------
// handleModelCommand
// ---------------------------------------------------------------------------

export function handleModelCommand(
	result: { args: string },
	params: {
		currentProvider: string | null;
		getSessionId: () => string | null;
		setSessionId: (id: string) => void;
		setProvider: (id: string) => void;
		setModel: (id: string | null) => void;
		setStatus: (status: string) => void;
		setContextLimit: (cl: number | null) => void;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
		clearVolatileMessages: () => void;
	},
): void {
	if (!params.currentProvider) {
		params.addVolatileMessage("Select a provider before selecting a model", "error");
		return;
	}
	if (!result.args) return;

	// Text searches that the tree couldn't resolve to an index are caught here
	if (!/^\d+$/.test(result.args.trim())) {
		params.addVolatileMessage(`No model matching "${result.args}"`, "error");
		return;
	}

	postDotCommand(
		"model",
		result.args,
		params.getSessionId(),
		(res) => {
			params.clearVolatileMessages();
			if (res.sessionId) params.setSessionId(res.sessionId);
			if (res.provider) params.setProvider(res.provider);
			if (res.model) params.setModel(res.model);
			if (res.status) params.setStatus(res.status);
			if (res.model) {
				params.setContextLimit(null);
				const effectiveProvider = res.provider ?? params.currentProvider;
				if (effectiveProvider) {
					params.addVolatileMessage(`Using ${effectiveProvider} ${res.model} model`, "info");
				}
			}
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleProviderCommand
// ---------------------------------------------------------------------------

export function handleProviderCommand(
	result: { args: string },
	params: {
		currentProvider: string | null;
		getSessionId: () => string | null;
		setSessionId: (id: string) => void;
		setProvider: (id: string) => void;
		setModel: (id: string | null) => void;
		setStatus: (status: string) => void;
		setContextLimit: (cl: number | null) => void;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
		clearVolatileMessages: () => void;
	},
): void {
	if (!result.args) return;

	// Text searches that the tree couldn't resolve to an index are caught here
	if (!/^\d+$/.test(result.args.trim())) {
		params.addVolatileMessage(`No provider matching "${result.args}"`, "error");
		return;
	}

	postDotCommand(
		"provider",
		result.args,
		params.getSessionId(),
		(res) => {
			params.clearVolatileMessages();
			if (res.sessionId) params.setSessionId(res.sessionId);
			if (res.provider) {
				params.setProvider(res.provider);
				params.setModel(null);
				params.setContextLimit(null);
			}
			if (res.status) params.setStatus(res.status);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleTitleCommand
// ---------------------------------------------------------------------------

export function handleTitleCommand(
	result: { text: string },
	params: {
		getSessionId: () => string | null;
		setSessionId: (id: string) => void;
		setTitle: (title: string | null) => void;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
		clearVolatileMessages: () => void;
	},
): void {
	postDotCommand(
		"title",
		result.text,
		params.getSessionId(),
		(res) => {
			params.clearVolatileMessages();
			if (res.sessionId) params.setSessionId(res.sessionId);
			params.setTitle(result.text);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleLimitCommand
// ---------------------------------------------------------------------------

export function handleLimitCommand(
	result: { value: string },
	params: {
		getSessionId: () => string | null;
		setSessionId: (id: string) => void;
		setStatus: (status: string) => void;
		setContextLimit: (cl: number | null) => void;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
		clearVolatileMessages: () => void;
	},
): void {
	postDotCommand(
		"limit",
		result.value,
		params.getSessionId(),
		(res) => {
			params.clearVolatileMessages();
			if (res.sessionId) params.setSessionId(res.sessionId);
			if (res.status) params.setStatus(res.status);
			params.setContextLimit(res.contextLimit ?? null);
		},
		params.addVolatileMessage,
	);
}

// ---------------------------------------------------------------------------
// handleSessionCommand
// ---------------------------------------------------------------------------

export function handleSessionCommand(
	result: { action: "load" | "delete" | "shortcut"; sessionId: string; title: string | null; owned: boolean },
	params: {
		getSessionId: () => string | null;
		loadSession: (id: string) => void;
		newChat: () => void;
		setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
		setStatus: (status: string) => void;
		defaultStatus: string;
		setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	},
): void {
	if (!result.sessionId) {
		params.addVolatileMessage("No session selected", "error");
		return;
	}

	if (result.action === "delete") {
		const isTargetSelf = result.sessionId === params.getSessionId();
		if (result.owned && !isTargetSelf) {
			params.addVolatileMessage("Cannot delete: session is active in another tab", "error");
			return;
		}
		if (isTargetSelf) {
			params.newChat();
			params.setStagedSkills([]);
			params.setStatus(params.defaultStatus);
			params.setView((prev) => ({ ...prev, mode: "chat" }));
		}
		fetch(`/bobai/session/${result.sessionId}`, { method: "DELETE" })
			.then((res) => res.json())
			.then((data: { ok: boolean; id?: string; title?: string | null; error?: string }) => {
				if (data.ok) {
					const label = data.title ? `${data.id} "${data.title}"` : (data.id ?? result.sessionId);
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

	// action === "load" or "shortcut"
	if (result.sessionId === params.getSessionId()) return;
	if (result.owned) {
		params.addVolatileMessage("Session is active in another tab", "error");
		return;
	}
	params.loadSession(result.sessionId);
	params.setStagedSkills([]);
	params.setView((prev) => ({ ...prev, mode: "chat" }));
}

// ---------------------------------------------------------------------------
// handleSubagentCommand
// ---------------------------------------------------------------------------

export function handleSubagentCommand(
	result: { sessionId: string; title: string },
	params: {
		subagents: SubagentInfo[];
		peekSubagentWithScroll: (sessionId: string) => void;
		peekSubagentFromDbWithScroll: (sessionId: string) => void;
		setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	},
): void {
	if (!result.sessionId) {
		params.addVolatileMessage("No subagent selected", "error");
		return;
	}
	const liveSubagent = params.subagents.find((s) => s.sessionId === result.sessionId && s.status === "running");
	if (liveSubagent) {
		params.peekSubagentWithScroll(liveSubagent.sessionId);
	} else {
		params.peekSubagentFromDbWithScroll(result.sessionId);
	}
	params.setStagedSkills([]);
}

// ---------------------------------------------------------------------------
// handleConfigurationCommand
// ---------------------------------------------------------------------------

export function handleConfigurationCommand(
	result: { args: string },
	params: {
		getSessionId: () => string | null;
		addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
		clearVolatileMessages: () => void;
		setResolvedDefaultProvider?: (provider: string) => void;
	},
): void {
	postDotCommand(
		"configuration",
		result.args,
		params.getSessionId(),
		(res) => {
			params.clearVolatileMessages();
			if (res.messages) {
				for (const msg of res.messages) {
					params.addVolatileMessage(msg.text, msg.kind);
				}
			}
			if (res.provider) {
				params.setResolvedDefaultProvider?.(res.provider);
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

// ---------------------------------------------------------------------------
// dispatchCommandResult — single dispatch point for all dot commands
// ---------------------------------------------------------------------------

export type DispatchDeps = {
	// new
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
	// view
	fetchContext: () => void;
	fetchCompactedContext: () => void;
	scrollToBottom: () => void;
	// model / provider / title / limit / configuration
	currentProvider: string | null;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setContextLimit: (cl: number | null) => void;
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
	clearVolatileMessages: () => void;
	// session
	loadSession: (id: string) => void;
	// subagent
	subagents: SubagentInfo[];
	peekSubagentWithScroll: (sessionId: string) => void;
	peekSubagentFromDbWithScroll: (sessionId: string) => void;
	// configuration
	setResolvedDefaultProvider?: (provider: string) => void;
};

export function dispatchCommandResult(result: DotCommandResult, deps: DispatchDeps): void {
	switch (result.command) {
		case "new":
			handleNewCommand(
				{ title: result.title },
				{
					newChat: deps.newChat,
					setStagedSkills: deps.setStagedSkills,
					setStatus: deps.setStatus,
					defaultStatus: deps.defaultStatus,
					setProvider: deps.setProvider,
					defaultProvider: deps.defaultProvider,
					setModel: deps.setModel,
					defaultModel: deps.defaultModel,
					setView: deps.setView,
					setTitle: deps.setTitle,
					pendingNewTitle: deps.pendingNewTitle,
					setWelcomeMarkdown: deps.setWelcomeMarkdown,
				},
			);
			break;
		case "view":
			handleViewCommand(
				{ arg: result.arg },
				{
					setView: deps.setView,
					fetchContext: deps.fetchContext,
					fetchCompactedContext: deps.fetchCompactedContext,
					scrollToBottom: deps.scrollToBottom,
				},
			);
			break;
		case "model":
			handleModelCommand(
				{ args: result.args },
				{
					currentProvider: deps.currentProvider,
					getSessionId: deps.getSessionId,
					setSessionId: deps.setSessionId,
					setProvider: deps.setProvider,
					setModel: deps.setModel,
					setStatus: deps.setStatus,
					setContextLimit: deps.setContextLimit,
					addVolatileMessage: deps.addVolatileMessage,
					clearVolatileMessages: deps.clearVolatileMessages,
				},
			);
			break;
		case "provider":
			handleProviderCommand(
				{ args: result.args },
				{
					currentProvider: deps.currentProvider,
					getSessionId: deps.getSessionId,
					setSessionId: deps.setSessionId,
					setProvider: deps.setProvider,
					setModel: deps.setModel,
					setStatus: deps.setStatus,
					setContextLimit: deps.setContextLimit,
					addVolatileMessage: deps.addVolatileMessage,
					clearVolatileMessages: deps.clearVolatileMessages,
				},
			);
			break;
		case "title":
			handleTitleCommand(
				{ text: result.text },
				{
					getSessionId: deps.getSessionId,
					setSessionId: deps.setSessionId,
					setTitle: deps.setTitle,
					addVolatileMessage: deps.addVolatileMessage,
					clearVolatileMessages: deps.clearVolatileMessages,
				},
			);
			break;
		case "limit":
			handleLimitCommand(
				{ value: result.value },
				{
					getSessionId: deps.getSessionId,
					setSessionId: deps.setSessionId,
					setStatus: deps.setStatus,
					setContextLimit: deps.setContextLimit,
					addVolatileMessage: deps.addVolatileMessage,
					clearVolatileMessages: deps.clearVolatileMessages,
				},
			);
			break;
		case "session":
			handleSessionCommand(
				{ action: result.action, sessionId: result.sessionId, title: result.title, owned: result.owned },
				{
					getSessionId: deps.getSessionId,
					loadSession: deps.loadSession,
					newChat: deps.newChat,
					setStagedSkills: deps.setStagedSkills,
					setStatus: deps.setStatus,
					defaultStatus: deps.defaultStatus,
					setView: deps.setView,
					addVolatileMessage: deps.addVolatileMessage,
				},
			);
			break;
		case "subagent":
			handleSubagentCommand(
				{ sessionId: result.sessionId, title: result.title },
				{
					subagents: deps.subagents,
					peekSubagentWithScroll: deps.peekSubagentWithScroll,
					peekSubagentFromDbWithScroll: deps.peekSubagentFromDbWithScroll,
					setStagedSkills: deps.setStagedSkills,
					addVolatileMessage: deps.addVolatileMessage,
				},
			);
			break;
		case "configuration":
			handleConfigurationCommand(
				{ args: result.args },
				{
					getSessionId: deps.getSessionId,
					addVolatileMessage: deps.addVolatileMessage,
					clearVolatileMessages: deps.clearVolatileMessages,
					setResolvedDefaultProvider: deps.setResolvedDefaultProvider,
				},
			);
			break;
	}
}
