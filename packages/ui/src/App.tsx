import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import type { MessagePart, StagedSkill, SubagentInfo } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

type Panel =
	| { type: "text"; content: string }
	| { type: "tool"; id: string; content: string; completed: boolean; mergeable: boolean; summary?: string };

interface ContextMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	metadata: Record<string, unknown> | null;
}

interface CompactionStats {
	compacted: number;
	superseded: number;
	contextPressure: number;
	totalToolMessages: number;
}

function groupParts(parts: MessagePart[]): Panel[] {
	// Pass 1: Create panels for each part
	const raw: Panel[] = [];
	const toolPanelMap = new Map<string, Panel & { type: "tool" }>();

	for (const part of parts) {
		if (part.type === "text") {
			raw.push({ type: "text", content: part.content });
		} else if (part.type === "tool_call") {
			const panel: Panel & { type: "tool" } = {
				type: "tool",
				id: part.id,
				content: part.content,
				completed: false,
				mergeable: false,
			};
			raw.push(panel);
			toolPanelMap.set(part.id, panel);
		} else if (part.type === "tool_result") {
			const panel = toolPanelMap.get(part.id);
			if (panel) {
				if (part.content !== null) {
					panel.content = part.content;
				}
				panel.completed = true;
				panel.mergeable = part.mergeable;
				if (part.summary) {
					panel.summary = part.summary;
				}
			}
		}
	}

	// Pass 2: Merge adjacent completed+mergeable tool panels
	const merged: Panel[] = [];
	for (const panel of raw) {
		const prev = merged.at(-1);
		if (
			panel.type === "tool" &&
			panel.completed &&
			panel.mergeable &&
			prev?.type === "tool" &&
			prev.completed &&
			prev.mergeable
		) {
			prev.content = `${prev.content}  \n${panel.content}`;
		} else {
			merged.push(panel);
		}
	}

	return merged;
}

function formatMsgSummary(msg: { summary?: string; model?: string }): string {
	return msg.summary ?? (msg.model ? ` | ${msg.model}` : "");
}

function truncateContent(text: string, lineLimit: number): string {
	if (lineLimit <= 0) return text;
	const lines = text.split("\n");
	if (lines.length <= lineLimit) return text;
	const headCount = 20;
	const tailCount = 20;
	const omitted = lines.length - headCount - tailCount;
	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	return `${head}\n... (${omitted} more lines)\n${tail}`;
}

function truncateChars(text: string, charLimit: number): string {
	if (charLimit <= 0 || text.length <= charLimit) return text;
	return text.slice(0, charLimit) + `... (${text.length - charLimit} more chars)`;
}

const VIEW_MODES = ["chat", "context", "compaction"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const FULL_DOT_COMMANDS = ["model", "new", "session", "subagent", "title", "view"] as const;
const READ_ONLY_DOT_COMMANDS = ["new", "session", "subagent", "title", "view"] as const;

export function App() {
	const {
		messages,
		connected,
		isStreaming,
		sendPrompt,
		newChat,
		setModel,
		title,
		setTitle,
		status,
		setStatus,
		subagents,
		addErrorMessage,
		parentId,
		parentTitle,
		loadSession,
		getSessionId,
		setSessionId,
	} = useWebSocket();
	const [input, setInput] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [modelList, setModelList] = useState<{ index: number; id: string; cost: string }[] | null>(null);
	const [skillList, setSkillList] = useState<{ name: string; description: string }[] | null>(null);
	const [stagedSkills, setStagedSkills] = useState<StagedSkill[]>([]);
	const defaultStatus = useRef("");
	const pendingNewTitle = useRef<string | null>(null);
	const historyEntries = useRef<string[]>([]);
	const [view, setView] = useState<{ mode: ViewMode; lineLimit: number }>({
		mode: "chat",
		lineLimit: 48,
	});
	const [contextMessages, setContextMessages] = useState<ContextMessage[] | null>(null);
	const [compactionData, setCompactionData] = useState<{ messages: ContextMessage[]; stats: CompactionStats | null } | null>(
		null,
	);
	const savedDraft = useRef("");
	const fetchGen = useRef(0);
	const messagesRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const autoScroll = useRef(true);

	// Mouse wheel disables autoscroll
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const onWheel = () => {
			autoScroll.current = false;
		};
		el.addEventListener("wheel", onWheel);
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	// PAGE UP/DOWN scrolls the messages panel globally (works even during streaming)
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "PageUp" && e.key !== "PageDown") return;
			e.preventDefault();
			const style = getComputedStyle(el);
			const lineHeight = parseFloat(style.fontSize) * parseFloat(style.lineHeight);
			const distance = el.clientHeight - lineHeight * 2;
			if (e.key === "PageUp") {
				el.scrollTop -= distance;
				autoScroll.current = false;
			} else {
				el.scrollTop += distance;
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
					autoScroll.current = true;
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Scroll to bottom on new content when autoscroll is active
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll even though ref is used
	useEffect(() => {
		if (!autoScroll.current) return;
		const el = messagesRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	useEffect(() => {
		if (!isStreaming && connected) {
			const ta = textareaRef.current;
			if (ta) {
				ta.focus();
				ta.selectionStart = ta.selectionEnd = ta.value.length;
			}
		}
	}, [isStreaming, connected]);

	// Global keydown: redirect printable keystrokes to the prompt textarea
	// when it's not already focused. Simpler than mousedown/visibility listeners
	// and doesn't interfere with mouse text selection.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const ta = textareaRef.current;
			if (!ta || document.activeElement === ta) return;
			// Skip modifier combos (Ctrl+C, etc.) and non-printable keys
			if (e.ctrlKey || e.altKey || e.metaKey) return;
			if (e.key.length > 1 && e.key !== "Backspace" && e.key !== "Delete") return;
			ta.focus();
			ta.selectionStart = ta.selectionEnd = ta.value.length;
			// Don't preventDefault — let the keystroke flow to the now-focused textarea
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Persist pending title from `.new <title>` after first prompt creates the session
	useEffect(() => {
		if (isStreaming || !connected) return;
		const pendingTitle = pendingNewTitle.current;
		if (!pendingTitle) return;
		const sid = getSessionId();
		if (!sid) return;
		// Clear only after confirming we have a sessionId — otherwise the effect
		// would fire immediately after `.new` (isStreaming=false, sid=null) and
		// discard the title before the first prompt creates the session.
		pendingNewTitle.current = null;
		fetch("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: pendingTitle, sessionId: sid }),
		}).catch(() => {});
	}, [isStreaming, connected, getSessionId]);

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}, []);

	const fetchContext = useCallback(() => {
		const sid = getSessionId();
		if (!sid) {
			setContextMessages(null);
			return;
		}
		fetch(`/bobai/session/${sid}/context`)
			.then((res) => res.json())
			.then((data: ContextMessage[]) => setContextMessages(data))
			.catch(() => setContextMessages(null));
	}, [getSessionId]);

	const fetchCompactedContext = useCallback(() => {
		const sid = getSessionId();
		if (!sid) {
			setCompactionData(null);
			return;
		}
		fetch(`/bobai/session/${sid}/context?compacted=true`)
			.then((res) => res.json())
			.then((data: { messages: ContextMessage[]; stats: CompactionStats | null }) => {
				setCompactionData({ messages: data.messages, stats: data.stats });
			})
			.catch(() => setCompactionData(null));
	}, [getSessionId]);

	// Adjust textarea height when navigating history
	// biome-ignore lint/correctness/useExhaustiveDependencies: adjustHeight is stable via useCallback
	useEffect(() => {
		requestAnimationFrame(adjustHeight);
	}, [historyIndex]);

	const isReadOnly = !!parentId || view.mode === "context" || view.mode === "compaction";
	const activeDotCommands = isReadOnly ? READ_ONLY_DOT_COMMANDS : FULL_DOT_COMMANDS;

	function clearInput() {
		setInput("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}

	function parseDotInput(text: string) {
		if (!text.startsWith(".")) return null;
		const withoutDot = text.slice(1);
		const spaceIndex = withoutDot.indexOf(" ");
		if (spaceIndex === -1) {
			const prefix = withoutDot.toLowerCase();
			const matches = activeDotCommands.filter((c) => c.startsWith(prefix));
			// Number shorthand: .model1 → command="model", args="1"
			// No dot command name contains a digit, so trailing digits are always an arg.
			if (matches.length === 0) {
				const m = prefix.match(/^([a-z]+)(\d+)$/);
				if (m) {
					const cmdPart = m[1];
					const numPart = m[2];
					const cmdMatches = activeDotCommands.filter((c) => c.startsWith(cmdPart));
					if (cmdMatches.length === 1) {
						return { mode: "args" as const, prefix: cmdPart, matches: cmdMatches, args: numPart, command: cmdMatches[0] };
					}
				}
			}
			return { mode: "select" as const, prefix, matches, args: "", command: undefined };
		}
		const cmdPart = withoutDot.slice(0, spaceIndex).toLowerCase();
		const matches = activeDotCommands.filter((c) => c.startsWith(cmdPart));
		if (matches.length === 1) {
			return { mode: "args" as const, prefix: cmdPart, matches, args: withoutDot.slice(spaceIndex + 1), command: matches[0] };
		}
		return { mode: "select" as const, prefix: cmdPart, matches, args: "", command: undefined };
	}

	function parseSlashInput(text: string) {
		if (!text.startsWith("/") || isReadOnly) return null;
		if (!skillList || skillList.length === 0) return null;
		const withoutSlash = text.slice(1);
		const prefix = withoutSlash.toLowerCase();
		const matches = skillList.filter((s) => s.name.toLowerCase().startsWith(prefix));
		return { prefix, matches };
	}

	// Fetch models eagerly on mount — needed for status bar and dot panel
	// biome-ignore lint/correctness/useExhaustiveDependencies: setModel/setStatus are stable React state setters
	useEffect(() => {
		fetch("/bobai/models")
			.then((res) => res.json())
			.then((data: { models: { index: number; id: string; cost: string }[]; defaultModel: string; defaultStatus: string }) => {
				setModelList(data.models);
				defaultStatus.current = data.defaultStatus;
				setModel((prev) => prev ?? data.defaultModel);
				setStatus((prev) => prev || data.defaultStatus);
			})
			.catch(() => {});
	}, []);

	// Fetch skills eagerly on mount — needed for slash command panel
	useEffect(() => {
		fetch("/bobai/skills")
			.then((res) => res.json())
			.then((data: { name: string; description: string }[]) => setSkillList(data))
			.catch(() => setSkillList(null));
	}, []);

	// Load most recent parent session on page reload
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadSession is stable via useCallback
	useEffect(() => {
		fetch("/bobai/sessions/recent")
			.then((res) => res.json())
			.then((data: { id: string; title: string | null; model: string | null } | null) => {
				if (data) {
					loadSession(data.id);
				}
			})
			.catch(() => {});
	}, []);

	const [sessionList, setSessionList] = useState<
		{ index: number; id: string; title: string | null; updatedAt: string }[] | null
	>(null);
	const [subagentList, setSubagentList] = useState<{ index: number; title: string; sessionId: string }[] | null>(null);

	// Fetch session list for .session panel
	// biome-ignore lint/correctness/useExhaustiveDependencies: parseDotInput is a local function that depends on activeDotCommands
	useEffect(() => {
		const parsed = parseDotInput(input);
		if (parsed?.mode === "args" && parsed.command === "session") {
			fetch("/bobai/sessions")
				.then((res) => res.json())
				.then((data) => setSessionList(data))
				.catch(() => setSessionList(null));
		} else {
			setSessionList(null);
		}
	}, [input, parentId]);

	// Fetch subagent list for .subagent panel
	// biome-ignore lint/correctness/useExhaustiveDependencies: parseDotInput is a local function that depends on activeDotCommands
	useEffect(() => {
		const parsed = parseDotInput(input);
		if (parsed?.mode === "args" && parsed.command === "subagent") {
			const sid = getSessionId();
			if (!sid) return;
			const targetParentId = parentId ?? sid;
			fetch(`/bobai/subagents?parentId=${targetParentId}`)
				.then((res) => res.json())
				.then((data) => setSubagentList(data))
				.catch(() => setSubagentList(null));
		} else {
			setSubagentList(null);
		}
	}, [input, parentId, getSessionId]);

	function stageSkill(name: string) {
		// Deduplicate
		if (stagedSkills.some((s) => s.name === name)) return;
		fetch("/bobai/skill", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		})
			.then((res) => {
				if (!res.ok) return;
				return res.json();
			})
			.then((data) => {
				if (!data) return;
				setStagedSkills((prev) => [...prev, { name: data.name, content: data.content }]);
			})
			.catch(() => {
				// Silently ignore
			});
	}

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;

		const parsed = parseDotInput(text);
		if (parsed?.mode === "args" && parsed.command) {
			// New chat: .new [optional title]
			if (parsed.command === "new") {
				newChat();
				setStagedSkills([]);
				setStatus(defaultStatus.current);
				setView((prev) => ({ ...prev, mode: "chat" }));
				const newTitle = parsed.args.trim();
				if (newTitle) {
					setTitle(newTitle);
					pendingNewTitle.current = newTitle;
				}
				clearInput();
				return;
			}

			// View command: select by index or cycle when no args
			if (parsed.command === "view") {
				const arg = parsed.args.trim();
				const viewMap: Record<string, ViewMode> = { "1": "chat", "2": "context", "3": "compaction" };
				setView((prev) => {
					const currentIdx = VIEW_MODES.indexOf(prev.mode);
					const next = arg ? (viewMap[arg] ?? prev.mode) : VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length];
					if (next === "context") fetchContext();
					if (next === "compaction") fetchCompactedContext();
					return { ...prev, mode: next };
				});
				clearInput();
				return;
			}

			// Session switching: .session <N> or .session (no args = list shown in panel)
			if (parsed.command === "session") {
				const arg = parsed.args.trim();
				if (!arg) {
					// .session with space but no number — no-op (list is in dot panel)
					clearInput();
					return;
				}
				const index = Number.parseInt(arg, 10);
				if (Number.isNaN(index) || index < 1 || !sessionList || index > sessionList.length) {
					addErrorMessage(`Invalid session index: ${arg}`);
					clearInput();
					return;
				}
				loadSession(sessionList[index - 1].id);
				setStagedSkills([]);
				clearInput();
				return;
			}

			// Subagent switching: .subagent <N>
			if (parsed.command === "subagent") {
				const arg = parsed.args.trim();
				if (!arg) {
					// .subagent with space but no number — no-op
					clearInput();
					return;
				}
				const index = Number.parseInt(arg, 10);
				if (Number.isNaN(index) || index < 1 || !subagentList || index > subagentList.length) {
					addErrorMessage(`Invalid subagent index: ${arg}`);
					clearInput();
					return;
				}
				loadSession(subagentList[index - 1].sessionId);
				setStagedSkills([]);
				clearInput();
				return;
			}

			const sid = getSessionId();
			fetch("/bobai/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: parsed.command, args: parsed.args.trim(), sessionId: sid }),
			})
				.then((res) => res.json())
				.then((result: { ok: boolean; error?: string; status?: string; sessionId?: string }) => {
					if (result.ok) {
						if (result.sessionId) {
							setSessionId(result.sessionId);
						}
						if (parsed.command === "model" && modelList) {
							const idx = Number.parseInt(parsed.args.trim(), 10);
							const selected = modelList.find((m) => m.index === idx);
							if (selected) setModel(selected.id);
						}
						if (parsed.command === "title") {
							setTitle(parsed.args.trim());
						}
						if (result.status) {
							setStatus(result.status);
						}
					} else {
						addErrorMessage(result.error ?? "Command failed");
					}
				})
				.catch(() => {
					addErrorMessage("Failed to execute command");
				});
			clearInput();
			return;
		}

		// View command without space (e.g. ".view", ".v", ".vi", ".vie")
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "view") {
			setView((prev) => {
				const currentIdx = VIEW_MODES.indexOf(prev.mode);
				const next = VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length];
				if (next === "context") fetchContext();
				if (next === "compaction") fetchCompactedContext();
				return { ...prev, mode: next };
			});
			clearInput();
			return;
		}

		// .session (no space): return to parent if in subagent, no-op if in parent
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "session") {
			if (parentId) {
				loadSession(parentId);
				setStagedSkills([]);
			}
			clearInput();
			return;
		}

		// .new (no space): start a new chat session
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "new") {
			newChat();
			setStagedSkills([]);
			setStatus(defaultStatus.current);
			setView((prev) => ({ ...prev, mode: "chat" }));
			clearInput();
			return;
		}

		// Incomplete or invalid dot command — don't send as prompt
		if (parsed) return;

		// Slash command: stage a skill
		const slashParsed = parseSlashInput(text);
		if (slashParsed) {
			if (slashParsed.matches.length === 1) {
				stageSkill(slashParsed.matches[0].name);
			}
			clearInput();
			return;
		}

		if (parentId) {
			addErrorMessage("Subagent sessions are read-only");
			clearInput();
			return;
		}

		if (view.mode === "context" || view.mode === "compaction") {
			addErrorMessage("Read-only view");
			clearInput();
			return;
		}

		if (isStreaming) return;
		autoScroll.current = true;
		setView((prev) => ({ ...prev, mode: "chat" }));
		sendPrompt(text, stagedSkills.length > 0 ? stagedSkills : undefined);
		setStagedSkills([]);
		setHistoryIndex(-1);
		clearInput();
	}

	function exitHistory(restoreValue: string) {
		setHistoryIndex(-1);
		setInput(restoreValue);
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		const inHistory = historyIndex >= 0;

		// History mode: intercept UP/DOWN/ESCAPE/ENTER before anything else
		if (inHistory) {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				const nextIndex = Math.min(historyIndex + 1, historyEntries.current.length - 1);
				if (nextIndex !== historyIndex) {
					setHistoryIndex(nextIndex);
					setInput(historyEntries.current[nextIndex]);
				}
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const nextIndex = historyIndex - 1;
				if (nextIndex < 0) {
					exitHistory(savedDraft.current);
				} else {
					setHistoryIndex(nextIndex);
					setInput(historyEntries.current[nextIndex]);
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				exitHistory(savedDraft.current);
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				// Copy history entry into input as editable text
				exitHistory(historyEntries.current[historyIndex]);
				return;
			}
			return;
		}

		// Not in history mode: UP at position 0 enters history mode
		if (e.key === "ArrowUp" && e.currentTarget.selectionStart === 0) {
			e.preventDefault();
			savedDraft.current = input;
			const gen = ++fetchGen.current;
			fetch("/bobai/prompts/recent?limit=10")
				.then((res) => {
					if (!res.ok) return;
					return res.json();
				})
				.then((entries: string[] | undefined) => {
					if (!entries || entries.length === 0) return;
					if (gen !== fetchGen.current) return;
					historyEntries.current = entries;
					setHistoryIndex(0);
					setInput(entries[0]);
				})
				.catch(() => {
					// Silently ignore fetch errors — user stays in normal mode
				});
			return;
		}

		if (e.key === "Enter") {
			// Dot commands: submit on any Enter (no modifier check, never multiline)
			if (parseDotInput(input)) {
				e.preventDefault();
				submit();
				return;
			}
			// Slash commands: submit on any Enter (like dot commands)
			if (parseSlashInput(input)) {
				e.preventDefault();
				submit();
				return;
			}
			// Regular prompts: Shift+Enter to submit, bare Enter for newline
			if (e.shiftKey) {
				e.preventDefault();
				submit();
			}
		}

		// Tab submits dot or slash commands; otherwise suppressed (no tab navigation)
		if (e.key === "Tab") {
			e.preventDefault();
			if (parseDotInput(input) || parseSlashInput(input)) {
				submit();
			}
		}
	}

	function renderDotPanel() {
		const parsed = parseDotInput(input);
		if (!parsed) return null;

		let content: React.ReactNode;

		if (parsed.mode === "select") {
			content =
				parsed.matches.length > 0 ? parsed.matches.map((cmd) => <div key={cmd}>{cmd}</div>) : <div>No matching commands</div>;
		} else if (parsed.command === "model") {
			if (!modelList) {
				content = "Loading models...";
			} else {
				const filtered = parsed.args ? modelList.filter((m) => String(m.index).startsWith(parsed.args.trim())) : modelList;
				content =
					filtered.length > 0 ? (
						filtered.map((m) => (
							<div key={m.id}>
								{m.index}: {m.id} ({m.cost})
							</div>
						))
					) : (
						<div>No matching models</div>
					);
			}
		} else if (parsed.command === "new") {
			const newTitle = parsed.args.trim();
			content = newTitle ? `Start a new chat session: ${newTitle}` : "Start a new chat session (optional title)";
		} else if (parsed.command === "title") {
			const titleText = parsed.args.trim();
			content = titleText ? `Set session title: ${titleText}` : "Enter session title";
		} else if (parsed.command === "session") {
			if (!sessionList) {
				content = "Loading sessions...";
			} else if (sessionList.length === 0) {
				content = "No sessions";
			} else {
				const filtered = parsed.args ? sessionList.filter((s) => String(s.index).startsWith(parsed.args.trim())) : sessionList;
				content =
					filtered.length > 0 ? (
						filtered.map((s) => (
							<div key={s.id}>
								{s.index}:{" "}
								{s.updatedAt
									.replace("T", " ")
									.replace(/\.\d+Z$/, "")
									.replace("Z", "")}{" "}
								{s.title ?? ""}
							</div>
						))
					) : (
						<div>No matching sessions</div>
					);
			}
		} else if (parsed.command === "subagent") {
			if (!subagentList) {
				content = "Loading subagents...";
			} else if (subagentList.length === 0) {
				content = "No subagent sessions";
			} else {
				const filtered = parsed.args
					? subagentList.filter((s) => String(s.index).startsWith(parsed.args.trim()))
					: subagentList;
				content =
					filtered.length > 0 ? (
						filtered.map((s) => (
							<div key={s.sessionId}>
								{s.index}: {s.title}
							</div>
						))
					) : (
						<div>No matching subagents</div>
					);
			}
		} else if (parsed.command === "view") {
			const views = [
				{ index: 1, name: "Chat", desc: "Grouped panels, markdown" },
				{ index: 2, name: "Context", desc: "Raw DB messages, plain text" },
				{ index: 3, name: "Compaction", desc: "Compacted view (what LLM sees)" },
			];
			content = views.map((v) => (
				<div key={v.index}>
					{v.index}: {v.name} — {v.desc}
				</div>
			));
		} else {
			return null;
		}

		return <div className="panel panel--dot">{content}</div>;
	}

	function renderSlashPanel() {
		const parsed = parseSlashInput(input);
		if (!parsed) return null;

		const content =
			parsed.matches.length > 0 ? (
				parsed.matches.map((s) => (
					<div key={s.name}>
						<strong>{s.name}</strong>: {s.description}
					</div>
				))
			) : (
				<div>No matching skills</div>
			);

		return <div className="panel panel--dot">{content}</div>;
	}

	function renderPanels() {
		const elements: React.ReactNode[] = [];
		let key = 0;

		for (const msg of messages) {
			if (msg.role === "user") {
				elements.push(
					<div key={key++} className="panel panel--user">
						{msg.text}
						<div className="panel-status">{msg.timestamp}</div>
					</div>,
				);
				continue;
			}

			const panels = groupParts(msg.parts);
			const msgSummary = formatMsgSummary(msg);
			for (let i = 0; i < panels.length; i++) {
				const panel = panels[i];
				const isLast = i === panels.length - 1;

				if (panel.type === "text") {
					elements.push(
						<div key={key++} className="panel panel--assistant">
							<Markdown>{panel.content}</Markdown>
							{isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{msgSummary}
								</div>
							)}
						</div>,
					);
				} else {
					elements.push(
						<div key={key++} className="panel panel--tool">
							<Markdown>{panel.content}</Markdown>
							{panel.summary && <div className="panel-status">{panel.summary}</div>}
							{!panel.summary && isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{msgSummary}
								</div>
							)}
						</div>,
					);
				}
			}
		}

		return elements;
	}

	function renderRawMessagePanels(
		msgs: ContextMessage[],
		limit: number,
		startKey: number,
	): { elements: React.ReactNode[]; nextKey: number } {
		const elements: React.ReactNode[] = [];
		let key = startKey;

		// Build a map from tool_call_id -> tool function name
		const toolCallNames = new Map<string, string>();
		for (const msg of msgs) {
			if (msg.role === "assistant" && msg.metadata?.tool_calls) {
				const calls = msg.metadata.tool_calls as Array<{ id: string; function: { name: string } }>;
				for (const tc of calls) {
					toolCallNames.set(tc.id, tc.function.name);
				}
			}
		}

		for (const msg of msgs) {
			if (msg.role === "system") {
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">system</div>
						<pre className="context-body">{truncateContent(msg.content, limit)}</pre>
					</div>,
				);
			} else if (msg.role === "user") {
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">user</div>
						<pre className="context-body">{truncateContent(msg.content, limit)}</pre>
					</div>,
				);
			} else if (msg.role === "assistant") {
				const toolCalls = msg.metadata?.tool_calls as
					| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
					| undefined;

				if (toolCalls && toolCalls.length > 0) {
					for (const tc of toolCalls) {
						elements.push(
							<div key={key++} className="panel panel--context">
								<div className="context-header">{`assistant | ${tc.id}`}</div>
								<pre className="context-body">{truncateChars(`${tc.function.name}(${tc.function.arguments})`, 512)}</pre>
							</div>,
						);
					}
				}

				if (msg.content) {
					elements.push(
						<div key={key++} className="panel panel--context">
							<div className="context-header">assistant</div>
							<pre className="context-body">{truncateContent(msg.content, limit)}</pre>
						</div>,
					);
				}
			} else if (msg.role === "tool") {
				const toolCallId = msg.metadata?.tool_call_id as string | undefined;
				const toolName = toolCallId ? (toolCallNames.get(toolCallId) ?? "unknown") : "unknown";
				const rawContent = msg.content || "(no output)";
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">{`tool | ${toolCallId ?? ""} | ${toolName}`}</div>
						<pre className="context-body">{truncateContent(rawContent, limit)}</pre>
					</div>,
				);
			}
		}

		return { elements, nextKey: key };
	}

	function renderContextPanels() {
		if (!contextMessages) {
			return [
				<div key="empty" className="panel panel--context">
					No session context available.
				</div>,
			];
		}
		const { elements } = renderRawMessagePanels(contextMessages, view.lineLimit, 0);
		return elements;
	}

	function renderCompactionPanels() {
		if (!compactionData) {
			return [
				<div key="empty" className="panel panel--context">
					No compaction data available.
				</div>,
			];
		}
		const { elements } = renderRawMessagePanels(compactionData.messages, view.lineLimit, 0);
		return elements;
	}

	return (
		<main className="app">
			<div className="panel panel--status-bar">
				<span>
					<span className="status-bar-label">Bob AI</span> <span className={`status-dot${connected ? "" : " disconnected"}`} />{" "}
					{connected ? "connected" : "connecting..."}
					{parentId ? (
						<span className="status-bar-title">
							{" "}
							{parentTitle ?? "(untitled)"} | {title ?? "(untitled)"}
						</span>
					) : (
						title && <span className="status-bar-title"> {title}</span>
					)}
				</span>
				<span>{status}</span>
			</div>

			<div className="messages" role="log" aria-live="polite" ref={messagesRef}>
				{view.mode === "chat" ? renderPanels() : view.mode === "context" ? renderContextPanels() : renderCompactionPanels()}
			</div>

			{stagedSkills.length > 0 && (
				<div className="panel panel--tool">
					{stagedSkills.map((s, i) => (
						<div key={s.name}>
							{`▸ Staging ${s.name} skill`}
							{i < stagedSkills.length - 1 ? "  " : ""}
						</div>
					))}
				</div>
			)}
			{renderDotPanel()}
			{renderSlashPanel()}

			<div className="panel panel--prompt">
				<textarea
					ref={textareaRef}
					className={historyIndex >= 0 ? "prompt-input prompt-input--history" : "prompt-input"}
					rows={1}
					spellCheck={false}
					value={input}
					readOnly={historyIndex >= 0}
					onChange={(e) => {
						setInput(e.target.value);
						adjustHeight();
					}}
					onKeyDown={handleKeyDown}
					placeholder={isReadOnly ? "Dot commands only (read-only)" : "Type a message..."}
					disabled={!connected || isStreaming}
				/>
			</div>
		</main>
	);
}
