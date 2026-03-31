import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { buildSessionUrl, parseSessionUrl } from "./urlUtils";
import type { MessagePart, StagedSkill } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

type Panel =
	| { type: "text"; content: string }
	| {
			type: "tool";
			id: string;
			content: string;
			completed: boolean;
			mergeable: boolean;
			summary?: string;
			subagentSessionId?: string;
	  };

interface ContextMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	metadata: Record<string, unknown> | null;
}

interface CompactionStats {
	compacted: number;
	assistantArgsCompacted: number;
	contextPressure: number;
	totalToolMessages: number;
}

interface CompactionDetail {
	age: number;
	compactionFactor: number;
	position: number;
	normalizedPosition: number;
	outputThreshold?: number;
	argsThreshold?: number;
	wasCompacted: boolean;
	belowMinSavings?: boolean;
	savedChars?: number;
	savedArgsChars?: number;
}

function formatToolHeader(toolCallId: string, toolName: string, detail: CompactionDetail | undefined): string {
	const parts = ["tool", toolCallId, toolName];

	if (!detail) {
		parts.push("no detail available");
		return parts.join(" | ");
	}

	// Position info: both raw and normalized (after MAX_AGE_DISTANCE capping)
	parts.push(`pos=${detail.position.toFixed(3)} norm=${detail.normalizedPosition.toFixed(3)}`);
	parts.push(`age=${detail.age.toFixed(3)}`);
	parts.push(`factor=${detail.compactionFactor.toFixed(3)}`);

	// Show thresholds
	const thresholds: string[] = [];
	if (detail.outputThreshold !== undefined) thresholds.push(`out=${detail.outputThreshold}`);
	if (detail.argsThreshold !== undefined) thresholds.push(`args=${detail.argsThreshold}`);
	if (thresholds.length > 0) parts.push(`threshold(${thresholds.join(", ")})`);

	// Compaction outcome
	if (detail.wasCompacted) {
		if (detail.savedChars !== undefined) {
			const argsSavings = detail.savedArgsChars !== undefined ? ` + ${detail.savedArgsChars} args` : "";
			parts.push(`compacted (saved ${detail.savedChars} chars${argsSavings})`);
		} else if (detail.savedArgsChars !== undefined) {
			parts.push(`args compacted (saved ${detail.savedArgsChars} chars)`);
		} else {
			parts.push("compacted");
		}
	} else if (detail.savedArgsChars !== undefined) {
		parts.push(`args compacted (saved ${detail.savedArgsChars} chars)`);
	} else if (detail.belowMinSavings) {
		parts.push("savings below minimum");
	} else if (detail.compactionFactor <= 0) {
		parts.push("no pressure");
	} else {
		parts.push("kept");
	}

	return parts.join(" | ");
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
				if (part.subagentSessionId) {
					panel.subagentSessionId = part.subagentSessionId;
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
	const trimmed = text.trim();
	if (lineLimit <= 0) return trimmed;
	const lines = trimmed.split("\n");
	if (lines.length <= lineLimit) return trimmed;
	const headCount = 20;
	const tailCount = 20;
	const omitted = lines.length - headCount - tailCount;
	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	return `${head}\n... (${omitted} more lines)\n${tail}`;
}

function truncateChars(text: string, charLimit: number): string {
	if (charLimit <= 0 || text.length <= charLimit) return text;
	return `${text.slice(0, charLimit)}... (${text.length - charLimit} more chars)`;
}

const VIEW_MODES = ["chat", "context", "compaction"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const FULL_DOT_COMMANDS = ["model", "new", "session", "subagent", "title", "view"] as const;
const READ_ONLY_DOT_COMMANDS = ["new", "session", "subagent", "title", "view"] as const;
const LOCKED_DOT_COMMANDS = ["new", "session"] as const;
const STREAMING_DOT_COMMANDS = ["stop", "subagent"] as const;

function ToolPanel({
	children,
	onNavigate,
	observe,
}: {
	children: React.ReactNode;
	onNavigate?: () => void;
	observe?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState<boolean | null>(null);
	const collapsible = useRef(false);
	const userToggled = useRef(false);

	// One-shot measurement on mount for static (non-streaming) panels.
	useEffect(() => {
		if (observe || !ref.current) return;
		if (userToggled.current) return;
		const threshold = window.innerHeight * 0.3;
		const shouldCollapse = ref.current.scrollHeight > threshold;
		collapsible.current = shouldCollapse;
		setCollapsed(shouldCollapse);
	}, [observe]);

	// ResizeObserver only for the actively-streaming panel.
	useEffect(() => {
		if (!observe || !ref.current) return;

		const el = ref.current;
		const observer = new ResizeObserver(() => {
			if (userToggled.current) return;
			const threshold = window.innerHeight * 0.3;
			const shouldCollapse = el.scrollHeight > threshold;
			if (shouldCollapse) {
				collapsible.current = true;
				setCollapsed(true);
				observer.disconnect();
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [observe]);

	const handleDoubleClick = () => {
		if (onNavigate) {
			onNavigate();
			window.getSelection()?.removeAllRanges();
			return;
		}
		if (collapsible.current) {
			userToggled.current = true;
			setCollapsed((prev) => !prev);
			window.getSelection()?.removeAllRanges();
		}
	};

	const isExpanded = collapsible.current && !collapsed;
	const cls = `panel panel--tool${collapsed ? " panel--collapsed" : ""}${isExpanded ? " panel--expanded" : ""}${onNavigate ? " panel--navigable" : ""}`;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click fold is a convenience shortcut, not primary interaction
		<div ref={ref} className={cls} onDoubleClick={handleDoubleClick}>
			{children}
		</div>
	);
}

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
		parentId,
		parentTitle,
		projectInfo,
		loadSession,
		getSessionId,
		setSessionId,
		volatileMessage,
		setVolatileMessage,
		sessionLocked,
		viewingSubagentId,
		peekSubagent,
		peekSubagentFromDb,
		exitSubagentPeek,
		sendCancel,
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
	const [compactionData, setCompactionData] = useState<{
		messages: ContextMessage[];
		stats: CompactionStats | null;
		details: Record<string, CompactionDetail> | null;
	} | null>(null);
	const savedDraft = useRef("");
	const fetchGen = useRef(0);
	const messagesRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const autoScroll = useRef(true);
	const savedScrollTop = useRef<number | null>(null);

	// Wrap peekSubagent to save scroll position before switching to child view
	const peekSubagentWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			peekSubagent(childSessionId);
		},
		[peekSubagent],
	);

	// Wrap peekSubagentFromDb to save scroll position before switching to child view
	const peekSubagentFromDbWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			peekSubagentFromDb(childSessionId);
		},
		[peekSubagentFromDb],
	);

	// Wrap exitSubagentPeek to restore scroll position after returning to parent view
	const exitSubagentPeekWithScroll = useCallback(() => {
		const scrollPos = savedScrollTop.current;
		exitSubagentPeek();
		if (scrollPos !== null) {
			autoScroll.current = false;
			requestAnimationFrame(() => {
				const el = messagesRef.current;
				if (el) el.scrollTop = scrollPos;
			});
			savedScrollTop.current = null;
		}
	}, [exitSubagentPeek]);

	// Unified scroll listener: determine autoscroll based on position.
	// Fires on every scroll event (mouse wheel, PageUp/Down, programmatic).
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const THRESHOLD = 2;
		const onScroll = () => {
			const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD;
			autoScroll.current = atBottom;
		};
		el.addEventListener("scroll", onScroll);
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// Update browser tab title when project info changes
	useEffect(() => {
		document.title = projectInfo ? `Bob AI | ${projectInfo.dir}` : "Bob AI";
	}, [projectInfo]);

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
			} else {
				el.scrollTop += distance;
			}
			// autoScroll state is handled by the scroll listener above
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
			.then(
				(data: {
					messages: ContextMessage[];
					stats: CompactionStats | null;
					details: Record<string, CompactionDetail> | null;
				}) => {
					setCompactionData({ messages: data.messages, stats: data.stats, details: data.details ?? null });
				},
			)
			.catch(() => setCompactionData(null));
	}, [getSessionId]);

	// Adjust textarea height when navigating history
	// biome-ignore lint/correctness/useExhaustiveDependencies: adjustHeight is stable via useCallback
	useEffect(() => {
		requestAnimationFrame(adjustHeight);
	}, [historyIndex]);

	const isReadOnly =
		!!parentId || sessionLocked || viewingSubagentId !== null || view.mode === "context" || view.mode === "compaction";
	const activeDotCommands = isStreaming
		? STREAMING_DOT_COMMANDS
		: sessionLocked
			? LOCKED_DOT_COMMANDS
			: isReadOnly
				? READ_ONLY_DOT_COMMANDS
				: FULL_DOT_COMMANDS;

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
				const cmdPart = m?.[1];
				const numPart = m?.[2];
				if (cmdPart && numPart) {
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

	function fuzzyMatchSkill(query: string, name: string): number | null {
		// Returns a score (lower is better) or null if no match.
		// Every character in query must appear in name in order.
		// Bonus for: matching at word starts (after '-'), consecutive matches.
		if (query.length === 0) return 0;

		const q = query.toLowerCase();
		const n = name.toLowerCase();

		// Fast path: prefix match gets the best possible score
		if (n.startsWith(q)) return 0;

		let qi = 0;
		let score = 0;
		let prevMatchIdx = -2; // track consecutive matches
		const wordStarts = new Set<number>([0]);
		for (let i = 0; i < n.length; i++) {
			if (n[i] === "-") wordStarts.add(i + 1);
		}

		for (let ni = 0; ni < n.length && qi < q.length; ni++) {
			if (n[ni] === q[qi]) {
				// Penalize non-word-start matches more
				const atWordStart = wordStarts.has(ni);
				score += atWordStart ? 0 : 1;
				// Penalize non-consecutive matches
				score += ni === prevMatchIdx + 1 ? 0 : 1;
				prevMatchIdx = ni;
				qi++;
			}
		}

		// All query characters consumed?
		if (qi < q.length) return null;
		return score;
	}

	function parseSlashInput(text: string) {
		if (!text.startsWith("/") || isReadOnly) return null;
		if (!skillList || skillList.length === 0) return null;
		const withoutSlash = text.slice(1);
		const query = withoutSlash.toLowerCase();
		const scored: { skill: (typeof skillList)[number]; score: number }[] = [];
		for (const s of skillList) {
			const score = fuzzyMatchSkill(query, s.name);
			if (score !== null) scored.push({ skill: s, score });
		}
		scored.sort((a, b) => a.score - b.score);
		const matches = scored.map((s) => s.skill);
		return { prefix: query, matches };
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

	// Load session from URL or most recent on page load
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadSession is stable via useCallback
	useEffect(() => {
		const { sessionId: urlSessionId } = parseSessionUrl(window.location.pathname);
		if (urlSessionId) {
			loadSession(urlSessionId, { skipUrlUpdate: true }).then((success) => {
				if (!success) {
					setVolatileMessage({ text: "Session not found", kind: "error" });
				}
			});
		} else {
			fetch("/bobai/sessions/recent")
				.then((res) => res.json())
				.then((data: { id: string; title: string | null; model: string | null } | null) => {
					if (data) {
						loadSession(data.id, { skipUrlUpdate: true }).then(() => {
							history.replaceState(null, "", buildSessionUrl(data.id));
						});
					}
				})
				.catch(() => {});
		}
	}, []);

	// Handle browser back/forward navigation
	useEffect(() => {
		const onPopState = () => {
			const { sessionId: urlSessionId } = parseSessionUrl(window.location.pathname);
			if (urlSessionId) {
				loadSession(urlSessionId, { skipUrlUpdate: true });
			} else {
				newChat();
			}
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [loadSession, newChat]);

	// Escape key exits subagent peek
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && viewingSubagentId) {
				e.preventDefault();
				exitSubagentPeekWithScroll();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [viewingSubagentId, exitSubagentPeekWithScroll]);

	const [sessionList, setSessionList] = useState<
		{ index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null
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

		setVolatileMessage(null);

		const parsed = parseDotInput(text);

		// When session is locked, only .new and .session commands are allowed
		if (sessionLocked) {
			const isNewCmd =
				(parsed?.mode === "args" && parsed.command === "new") ||
				(parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "new");
			const isSessionCmd =
				(parsed?.mode === "args" && parsed.command === "session") ||
				(parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "session");
			if (!isNewCmd && !isSessionCmd) {
				clearInput();
				return;
			}
		}

		if (parsed?.mode === "args" && parsed.command) {
			// Stop: cancel the running agent loop
			if (parsed.command === "stop") {
				sendCancel();
				clearInput();
				return;
			}

			// New chat: .new [optional title]
			if (parsed.command === "new") {
				newChat();
				setStagedSkills([]);
				setStatus(defaultStatus.current);
				setView((prev) => ({ ...prev, mode: "chat" }));
				const newTitle = (parsed.args ?? "").trim();
				if (newTitle) {
					setTitle(newTitle);
					pendingNewTitle.current = newTitle;
				}
				clearInput();
				return;
			}

			// View command: select by index or cycle when no args
			if (parsed.command === "view") {
				const arg = (parsed.args ?? "").trim();
				const viewMap: Record<string, ViewMode> = { "1": "chat", "2": "context", "3": "compaction" };
				setView((prev) => {
					const currentIdx = VIEW_MODES.indexOf(prev.mode);
					const next = arg ? (viewMap[arg] ?? prev.mode) : (VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length] ?? "chat");
					if (next === "context") fetchContext();
					if (next === "compaction") fetchCompactedContext();
					return { ...prev, mode: next };
				});
				clearInput();
				return;
			}

			// Session switching: .session <N> or .session (no args = list shown in panel)
			if (parsed.command === "session") {
				const arg = (parsed.args ?? "").trim();
				if (!arg) {
					// .session with space but no number — no-op (list is in dot panel)
					clearInput();
					return;
				}
				const parts = arg.split(/\s+/);
				const indexStr = parts[0] ?? "";
				const index = Number.parseInt(indexStr, 10);
				const subcommand = parts[1];
				if (Number.isNaN(index) || index < 1 || !sessionList || index > sessionList.length) {
					setVolatileMessage({ text: `Invalid session index: ${indexStr}`, kind: "error" });
					clearInput();
					return;
				}
				const targetSession = sessionList[index - 1];
				if (!targetSession) {
					setVolatileMessage({ text: `Invalid session index: ${indexStr}`, kind: "error" });
					clearInput();
					return;
				}

				// Delete subcommand: .session N delete
				if (subcommand === "delete") {
					const isTargetSelf = targetSession.id === getSessionId();
					const isOwnedByOther = targetSession.owned && !isTargetSelf;
					if (isOwnedByOther) {
						setVolatileMessage({ text: "Cannot delete: session is active in another tab", kind: "error" });
						clearInput();
						return;
					}
					// If deleting current session, clear it first (releases ownership)
					if (isTargetSelf) {
						newChat();
						setStagedSkills([]);
						setStatus(defaultStatus.current);
						setView((prev) => ({ ...prev, mode: "chat" }));
					}
					fetch(`/bobai/session/${targetSession.id}`, { method: "DELETE" })
						.then((res) => res.json())
						.then((data: { ok: boolean; id?: string; title?: string | null; error?: string }) => {
							if (data.ok) {
								const label = data.title ? `${data.id} "${data.title}"` : (data.id ?? targetSession.id);
								setVolatileMessage({ text: `Session ${label} has been removed`, kind: "success" });
							} else {
								setVolatileMessage({ text: data.error ?? "Failed to delete session", kind: "error" });
							}
						})
						.catch(() => {
							setVolatileMessage({ text: "Failed to delete session", kind: "error" });
						});
					clearInput();
					return;
				}

				// Session switching (no subcommand)
				const isTargetSelf = targetSession.id === getSessionId();
				if (isTargetSelf) {
					// Already viewing this session — no-op
					clearInput();
					return;
				}
				if (targetSession.owned) {
					setVolatileMessage({ text: "Session is active in another tab", kind: "error" });
					clearInput();
					return;
				}
				loadSession(targetSession.id);
				setStagedSkills([]);
				clearInput();
				return;
			}

			// Subagent switching: .subagent <N>
			if (parsed.command === "subagent") {
				const arg = (parsed.args ?? "").trim();
				if (!arg) {
					// .subagent with space but no number — no-op
					clearInput();
					return;
				}
				const index = Number.parseInt(arg, 10);
				if (Number.isNaN(index) || index < 1 || !subagentList || index > subagentList.length) {
					setVolatileMessage({ text: `Invalid subagent index: ${arg}`, kind: "error" });
					clearInput();
					return;
				}
				const targetSubagent = subagentList[index - 1];
				if (!targetSubagent) {
					setVolatileMessage({ text: `Invalid subagent index: ${arg}`, kind: "error" });
					clearInput();
					return;
				}
				// Check if this subagent is currently live (running) — use peek instead of DB load
				const liveSubagent = subagents.find((s) => s.sessionId === targetSubagent.sessionId && s.status === "running");
				if (liveSubagent) {
					peekSubagentWithScroll(liveSubagent.sessionId);
				} else {
					peekSubagentFromDbWithScroll(targetSubagent.sessionId);
				}
				setStagedSkills([]);
				clearInput();
				return;
			}

			const sid = getSessionId();
			fetch("/bobai/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: parsed.command, args: (parsed.args ?? "").trim(), sessionId: sid }),
			})
				.then((res) => res.json())
				.then((result: { ok: boolean; error?: string; status?: string; sessionId?: string }) => {
					if (result.ok) {
						if (result.sessionId) {
							setSessionId(result.sessionId);
						}
						if (parsed.command === "model" && modelList) {
							const idx = Number.parseInt((parsed.args ?? "").trim(), 10);
							const selected = modelList.find((m) => m.index === idx);
							if (selected) setModel(selected.id);
						}
						if (parsed.command === "title") {
							setTitle((parsed.args ?? "").trim());
						}
						if (result.status) {
							setStatus(result.status);
						}
					} else {
						setVolatileMessage({ text: result.error ?? "Command failed", kind: "error" });
					}
				})
				.catch(() => {
					setVolatileMessage({ text: "Failed to execute command", kind: "error" });
				});
			clearInput();
			return;
		}

		// View command without space (e.g. ".view", ".v", ".vi", ".vie")
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "view") {
			setView((prev) => {
				const currentIdx = VIEW_MODES.indexOf(prev.mode);
				const next = VIEW_MODES[(currentIdx + 1) % VIEW_MODES.length] ?? "chat";
				if (next === "context") fetchContext();
				if (next === "compaction") fetchCompactedContext();
				return { ...prev, mode: next };
			});
			clearInput();
			return;
		}

		// .session (no space): exit peek, return to parent if in subagent, no-op if in parent
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "session") {
			if (viewingSubagentId) {
				exitSubagentPeekWithScroll();
				setStagedSkills([]);
			} else if (parentId) {
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

		// .stop (no space): cancel the running agent loop
		if (parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0] === "stop") {
			sendCancel();
			clearInput();
			return;
		}

		// Incomplete or invalid dot command — don't send as prompt
		if (parsed) return;

		// Slash command: stage a skill
		const slashParsed = parseSlashInput(text);
		if (slashParsed) {
			if (slashParsed.matches.length === 1) {
				const name = slashParsed.matches[0]?.name;
				if (name) stageSkill(name);
			}
			clearInput();
			return;
		}

		if (parentId) {
			setVolatileMessage({ text: "Subagent sessions are read-only", kind: "error" });
			clearInput();
			return;
		}

		if (view.mode === "context" || view.mode === "compaction") {
			setVolatileMessage({ text: "Read-only view", kind: "error" });
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
					setInput(historyEntries.current[nextIndex] ?? "");
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
					setInput(historyEntries.current[nextIndex] ?? "");
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
				exitHistory(historyEntries.current[historyIndex] ?? "");
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
					setInput(entries[0] ?? "");
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
			// Slash commands: submit on any Enter (like dot commands) — blocked during streaming
			if (!isStreaming && parseSlashInput(input)) {
				e.preventDefault();
				submit();
				return;
			}
			// Regular prompts: Shift+Enter to submit, bare Enter for newline
			if (!isStreaming && e.shiftKey) {
				e.preventDefault();
				submit();
			}
		}

		// Tab submits dot or slash commands; otherwise suppressed (no tab navigation)
		if (e.key === "Tab") {
			e.preventDefault();
			if (parseDotInput(input) || (!isStreaming && parseSlashInput(input))) {
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
				const argText = (parsed.args ?? "").trim();
				const argParts = argText.split(/\s+/);
				const indexPart = argParts[0] ?? "";
				const subcommand = argParts[1];

				// If user typed "N delete", show a delete preview instead of the session list
				if (subcommand === "delete") {
					const idx = Number.parseInt(indexPart, 10);
					if (!Number.isNaN(idx) && idx >= 1 && idx <= sessionList.length) {
						const target = sessionList[idx - 1];
						const label = target?.title ? `"${target.title}"` : `#${idx}`;
						content = `Delete session ${label}`;
					} else {
						content = `Invalid session index: ${indexPart}`;
					}
				} else {
					const filtered = argText ? sessionList.filter((s) => String(s.index).startsWith(indexPart)) : sessionList;
					content =
						filtered.length > 0 ? (
							filtered.map((s) => {
								const isCurrentSession = s.id === getSessionId();
								const isOwnedBySelf = isCurrentSession && !sessionLocked;
								const isOwnedByOther = s.owned && !isOwnedBySelf;
								const localTime = new Date(s.updatedAt)
									.toLocaleString("sv-SE", {
										year: "numeric",
										month: "2-digit",
										day: "2-digit",
										hour: "2-digit",
										minute: "2-digit",
										second: "2-digit",
										hour12: false,
									})
									.replace(",", "");
								return (
									<div key={s.id}>
										{s.index}: {localTime} {s.title ?? ""}
										{isOwnedByOther ? " (active in another tab)" : ""}
										{isOwnedBySelf ? " (this session)" : ""}
									</div>
								);
							})
						) : (
							<div>No matching sessions</div>
						);
				}
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
					<div key={s.name} className="slash-skill-row">
						{s.name} <span className="slash-skill-desc">({s.description})</span>
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

		for (let m = 0; m < messages.length; m++) {
			const msg = messages[m];
			if (!msg) continue;
			const isLastMsg = m === messages.length - 1;
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
				if (!panel) continue;
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
					const linkedSubagent = subagents.find((s) => s.toolCallId === panel.id);
					const subagentSessionId = linkedSubagent?.sessionId ?? panel.subagentSessionId;
					const onNavigate = subagentSessionId
						? () => {
								if (linkedSubagent?.status === "running") {
									peekSubagentWithScroll(subagentSessionId);
								} else {
									peekSubagentFromDbWithScroll(subagentSessionId);
								}
							}
						: undefined;
					const shouldObserve = isStreaming && isLastMsg && !panel.completed;

					elements.push(
						<ToolPanel key={key++} onNavigate={onNavigate} observe={shouldObserve}>
							<Markdown>{panel.content}</Markdown>
							{panel.summary && <div className="panel-status">{panel.summary}</div>}
							{!panel.summary && isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{msgSummary}
								</div>
							)}
						</ToolPanel>,
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

				if (msg.content) {
					elements.push(
						<div key={key++} className="panel panel--context">
							<div className="context-header">assistant</div>
							<pre className="context-body">{truncateContent(msg.content, limit)}</pre>
						</div>,
					);
				}

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
			} else if (msg.role === "tool") {
				const toolCallId = msg.metadata?.tool_call_id as string | undefined;
				const toolName = toolCallId ? (toolCallNames.get(toolCallId) ?? "unknown") : "unknown";
				const rawContent = (msg.content || "(no output)").trim();
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

	function renderCompactionMessagePanels(
		msgs: ContextMessage[],
		details: Record<string, CompactionDetail> | null,
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
						<div className="context-header">system | excluded from compaction</div>
						<pre className="context-body">{msg.content?.trim()}</pre>
					</div>,
				);
			} else if (msg.role === "user") {
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">user | excluded from compaction</div>
						<pre className="context-body">{msg.content?.trim()}</pre>
					</div>,
				);
			} else if (msg.role === "assistant") {
				const toolCalls = msg.metadata?.tool_calls as
					| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
					| undefined;

				if (msg.content) {
					elements.push(
						<div key={key++} className="panel panel--context">
							<div className="context-header">assistant | excluded from compaction</div>
							<pre className="context-body">{msg.content.trim()}</pre>
						</div>,
					);
				}

				if (toolCalls && toolCalls.length > 0) {
					for (const tc of toolCalls) {
						elements.push(
							<div key={key++} className="panel panel--context">
								<div className="context-header">{`assistant | ${tc.id} | excluded from compaction`}</div>
								<pre className="context-body">{`${tc.function.name}(${tc.function.arguments})`}</pre>
							</div>,
						);
					}
				}
			} else if (msg.role === "tool") {
				const toolCallId = msg.metadata?.tool_call_id as string | undefined;
				const toolName = toolCallId ? (toolCallNames.get(toolCallId) ?? "unknown") : "unknown";
				const detail = toolCallId && details ? details[toolCallId] : undefined;
				const header = formatToolHeader(toolCallId ?? "", toolName, detail);
				const rawContent = (msg.content || "(no output)").trim();
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">{header}</div>
						<pre className="context-body">{rawContent}</pre>
					</div>,
				);
			}
		}

		return { elements, nextKey: key };
	}

	function renderCompactionPanels() {
		if (!compactionData) {
			return [
				<div key="empty" className="panel panel--context">
					No compaction data available.
				</div>,
			];
		}
		const { elements } = renderCompactionMessagePanels(compactionData.messages, compactionData.details, 0);
		return elements;
	}

	const agentActive = isStreaming || subagents.some((s) => s.status === "running");
	const peekingSubagent = viewingSubagentId ? subagents.find((s) => s.sessionId === viewingSubagentId) : null;

	return (
		<main className="app">
			<div className="panel panel--status-bar">
				<span>
					<span className={`status-bar-label${connected && agentActive ? " active" : ""}`}>Bob AI</span>{" "}
					<span className={`status-dot${connected ? "" : " disconnected"}${connected && agentActive ? " active" : ""}`} />
					{connected ? (
						<>
							{projectInfo && <span className="status-bar-title"> {projectInfo.dir}</span>}
							{projectInfo?.git && (
								<span className="status-bar-title">
									{" "}
									| {projectInfo.git.branch}:{projectInfo.git.revision}
								</span>
							)}
							{peekingSubagent ? (
								<span className="status-bar-title">
									{" "}
									| {title ?? "(untitled)"} | {peekingSubagent.title}
								</span>
							) : parentId ? (
								<span className="status-bar-title">
									{" "}
									| {parentTitle ?? "(untitled)"} | {title ?? "(untitled)"}
								</span>
							) : (
								title && <span className="status-bar-title"> | {title}</span>
							)}
						</>
					) : (
						" connecting..."
					)}
				</span>
				<span>{status}</span>
			</div>

			<div className="messages" role="log" aria-live="polite" ref={messagesRef}>
				{!sessionLocked &&
					(view.mode === "chat" ? renderPanels() : view.mode === "context" ? renderContextPanels() : renderCompactionPanels())}
			</div>

			{volatileMessage && (
				<div className={`panel panel--volatile panel--volatile-${volatileMessage.kind}`}>{volatileMessage.text}</div>
			)}

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
					placeholder={
						isStreaming && viewingSubagentId
							? "Escape to return — .stop to cancel"
							: isStreaming
								? "Agent working — .stop to cancel"
								: viewingSubagentId
									? "Viewing subagent — press Escape to return"
									: sessionLocked
										? "Use .new or .session to navigate"
										: isReadOnly
											? "Dot commands only (read-only)"
											: "Type a message..."
					}
					disabled={!connected}
				/>
			</div>
		</main>
	);
}
