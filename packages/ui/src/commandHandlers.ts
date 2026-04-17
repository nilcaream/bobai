import type { ViewMode } from "./commandParser";
import { fuzzyFilterAndSort, VIEW_MODES } from "./commandParser";
import type { ModelListItem } from "./DotCommandPanel";
import type { StagedSkill, SubagentInfo } from "./protocol";

// ---------------------------------------------------------------------------
// Shared context types
// ---------------------------------------------------------------------------

interface VolatileMessageSetter {
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void;
}

function resolveVisibleModel(modelList: ModelListItem[], arg: string): ModelListItem | undefined {
	const trimmed = arg.trim();
	const firstToken = trimmed.split(/\s+/)[0] ?? "";
	if (!trimmed) return undefined;
	if (/^\d+$/.test(firstToken)) {
		const idx = Number.parseInt(firstToken, 10);
		return modelList.find((m) => m.index === idx);
	}
	return fuzzyFilterAndSort(modelList, trimmed, (m) => m.id)[0];
}

// ---------------------------------------------------------------------------
// handleStopCommand
// ---------------------------------------------------------------------------

export function handleStopCommand(params: { sendCancel: () => void }): void {
	params.sendCancel();
}

// ---------------------------------------------------------------------------
// handleNewCommand
// ---------------------------------------------------------------------------

export function handleNewCommand(params: {
	newChat: () => void;
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	setStatus: (status: string) => void;
	defaultStatus: string;
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>;
	setTitle: (title: string | null) => void;
	pendingNewTitle: React.MutableRefObject<string | null>;
	setWelcomeMarkdown: (md: string | null) => void;
	newTitle: string;
}): void {
	params.newChat();
	params.setStagedSkills([]);
	params.setStatus(params.defaultStatus);
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
	// After switching view mode, scroll to the bottom so the user sees the
	// latest content. Uses requestAnimationFrame to wait for React to render
	// the new view content before scrolling.
	requestAnimationFrame(() => params.scrollToBottom());
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
	addVolatileMessage: VolatileMessageSetter["addVolatileMessage"];
}): void {
	if (!params.arg) {
		// .session with space but no number — no-op (list is in dot panel)
		return;
	}
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
		// Pick the first match, applying self/owned rules
		const currentId = params.getSessionId();
		const first = matches[0] as (typeof matches)[0];
		if (first.id === currentId) {
			// Self — silently no-op (idempotent)
			return;
		}
		if (first.owned) {
			params.addVolatileMessage("Session is active in another tab", "error");
			return;
		}
		params.loadSession(first.id);
		params.setStagedSkills([]);
		params.setView((prev) => ({ ...prev, mode: "chat" }));
		return;
	}

	// Numeric mode: index-based selection
	const index = Number.parseInt(firstWord, 10);
	const subcommand = parts[1];
	const targetSession = params.sessionList.find((s) => s.index === index);
	if (!targetSession) {
		params.addVolatileMessage(`Invalid session index: ${firstWord}`, "error");
		return;
	}

	// Delete subcommand: .session N delete (only recognized subcommand)
	if (subcommand) {
		if (subcommand !== "delete") {
			params.addVolatileMessage(`Unknown subcommand: ${subcommand}`, "error");
			return;
		}
		const isTargetSelf = targetSession.id === params.getSessionId();
		const isOwnedByOther = targetSession.owned && !isTargetSelf;
		if (isOwnedByOther) {
			params.addVolatileMessage("Cannot delete: session is active in another tab", "error");
			return;
		}
		// If deleting current session, clear it first (releases ownership)
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

	// Session switching (no subcommand)
	const isTargetSelf = targetSession.id === params.getSessionId();
	if (isTargetSelf) {
		// Already viewing this session — no-op
		return;
	}
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
	addVolatileMessage: VolatileMessageSetter["addVolatileMessage"];
}): void {
	if (!params.arg) {
		// .subagent with space but no number — no-op
		return;
	}
	if (!params.subagentList) {
		params.addVolatileMessage("Subagent list not loaded", "error");
		return;
	}
	const trimmedArg = params.arg.trim();
	const firstWord = trimmedArg.split(/\s+/)[0] ?? "";
	const isNumeric = /^\d+$/.test(firstWord);
	const targetSubagent = isNumeric
		? params.subagentList.find((s) => s.index === Number.parseInt(firstWord, 10))
		: fuzzyFilterAndSort(params.subagentList, trimmedArg, (s) => s.title)[0];
	if (!targetSubagent) {
		params.addVolatileMessage(
			isNumeric ? `Invalid subagent index: ${params.arg}` : `No subagent matching "${params.arg}"`,
			"error",
		);
		return;
	}
	// Check if this subagent is currently live (running) — use peek instead of DB load
	const liveSubagent = params.subagents.find((s) => s.sessionId === targetSubagent.sessionId && s.status === "running");
	if (liveSubagent) {
		params.peekSubagentWithScroll(liveSubagent.sessionId);
	} else {
		params.peekSubagentFromDbWithScroll(targetSubagent.sessionId);
	}
	params.setStagedSkills([]);
}

// ---------------------------------------------------------------------------
// handleGenericCommand
// ---------------------------------------------------------------------------

export function handleGenericCommand(params: {
	command: string;
	args: string;
	getSessionId: () => string | null;
	setSessionId: (id: string) => void;
	setModel: (id: string) => void;
	setTitle: (title: string | null) => void;
	setStatus: (status: string) => void;
	addVolatileMessage: VolatileMessageSetter["addVolatileMessage"];
	modelList: ModelListItem[] | null;
}): void {
	const sid = params.getSessionId();
	const resolvedModel =
		params.command === "model" && params.modelList ? resolveVisibleModel(params.modelList, params.args) : undefined;
	const submittedArgs = params.command === "model" && resolvedModel ? String(resolvedModel.index) : params.args;
	const firstToken = params.args.trim().split(/\s+/)[0] ?? "";
	const isNumericModelArg = params.command === "model" && /^\d+$/.test(firstToken);
	if (params.command === "model" && params.modelList && params.args.trim() && !resolvedModel && !isNumericModelArg) {
		params.addVolatileMessage(`No model matching "${params.args}"`, "error");
		return;
	}
	fetch("/bobai/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ command: params.command, args: submittedArgs, sessionId: sid }),
	})
		.then((res) => res.json())
		.then((result: { ok: boolean; error?: string; status?: string; sessionId?: string }) => {
			if (result.ok) {
				if (result.sessionId) {
					params.setSessionId(result.sessionId);
				}
				if (params.command === "model") {
					const selected =
						resolvedModel ?? (params.modelList ? resolveVisibleModel(params.modelList, submittedArgs) : undefined);
					if (selected) params.setModel(selected.id);
				}
				if (params.command === "title") {
					params.setTitle(params.args);
				}
				if (result.status) {
					params.setStatus(result.status);
				}
			} else {
				params.addVolatileMessage(result.error ?? "Command failed", "error");
			}
		})
		.catch(() => {
			params.addVolatileMessage("Failed to execute command", "error");
		});
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
// handleSlashCommand (was stageSkill)
// ---------------------------------------------------------------------------

export function handleSlashCommand(params: {
	name: string;
	stagedSkills: StagedSkill[];
	setStagedSkills: React.Dispatch<React.SetStateAction<StagedSkill[]>>;
	addVolatileMessage: VolatileMessageSetter["addVolatileMessage"];
}): void {
	// Deduplicate
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
		.catch(() => {
			// Silently ignore
		});
}
