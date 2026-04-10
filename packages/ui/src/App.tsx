import { useCallback, useEffect, useRef, useState } from "react";
import {
	handleGenericCommand,
	handleNewCommand,
	handleSessionCommand,
	handleSessionShortcut,
	handleSlashCommand,
	handleStopCommand,
	handleSubagentCommand,
	handleViewCommand,
} from "./commandHandlers";
import type { ViewMode } from "./commandParser";
import {
	FULL_DOT_COMMANDS,
	LOCKED_DOT_COMMANDS,
	parseDotInput,
	parseSlashInput,
	READ_ONLY_DOT_COMMANDS,
	STREAMING_DOT_COMMANDS,
} from "./commandParser";
import type { CompactionDetail, CompactionStats, ContextMessage } from "./formatUtils";
import { formatMsgSummary, formatToolHeader, groupParts, truncateChars, truncateContent } from "./formatUtils";
import { useAutoScroll } from "./hooks/useAutoScroll";
import { useGlobalKeyboard } from "./hooks/useGlobalKeyboard";
import { useInputHistory } from "./hooks/useInputHistory";
import { useSessionRouting } from "./hooks/useSessionRouting";
import { Markdown } from "./Markdown";
import type { StagedSkill } from "./protocol";
import { ToolPanel } from "./ToolPanel";
import { useWebSocket } from "./useWebSocket";

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
		viewingSubagentTitle,
		welcomeMarkdown,
		setWelcomeMarkdown,
		peekSubagent,
		peekSubagentFromDb,
		exitSubagentPeek,
		sendCancel,
	} = useWebSocket();
	const [input, setInput] = useState("");
	const [modelList, setModelList] = useState<{ index: number; id: string; cost: string }[] | null>(null);
	const [skillList, setSkillList] = useState<{ name: string; description: string }[] | null>(null);
	const [stagedSkills, setStagedSkills] = useState<StagedSkill[]>([]);
	const defaultStatus = useRef("");
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
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const { messagesRef, autoScrollRef, peekSubagentWithScroll, peekSubagentFromDbWithScroll, exitSubagentPeekWithScroll } =
		useAutoScroll(messages, peekSubagent, peekSubagentFromDb, exitSubagentPeek, setView);

	const { pendingNewTitle } = useSessionRouting(
		loadSession,
		newChat,
		setWelcomeMarkdown,
		setVolatileMessage,
		isStreaming,
		connected,
		getSessionId,
	);

	// Update browser tab title when project info changes
	useEffect(() => {
		document.title = projectInfo ? `Bob AI | ${projectInfo.dir}` : "Bob AI";
	}, [projectInfo]);

	useGlobalKeyboard(messagesRef, textareaRef, viewingSubagentId, exitSubagentPeekWithScroll, isStreaming, connected);

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}, []);

	const { historyIndex, resetHistory, handleHistoryKeyDown } = useInputHistory(input, setInput, adjustHeight);

	const fetchContext = useCallback(() => {
		const sid = viewingSubagentId ?? getSessionId();
		if (!sid) {
			setContextMessages(null);
			return;
		}
		fetch(`/bobai/session/${sid}/context`)
			.then((res) => res.json())
			.then((data: ContextMessage[]) => setContextMessages(data))
			.catch(() => setContextMessages(null));
	}, [getSessionId, viewingSubagentId]);

	const fetchCompactedContext = useCallback(() => {
		const sid = viewingSubagentId ?? getSessionId();
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
	}, [getSessionId, viewingSubagentId]);

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

	const [sessionList, setSessionList] = useState<
		{ index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null
	>(null);
	const [subagentList, setSubagentList] = useState<{ index: number; title: string; sessionId: string }[] | null>(null);

	// Fetch session list for .session panel
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeDotCommands depends on component state
	useEffect(() => {
		const parsed = parseDotInput(input, activeDotCommands);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeDotCommands depends on component state
	useEffect(() => {
		const parsed = parseDotInput(input, activeDotCommands);
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

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;

		setVolatileMessage(null);

		const parsed = parseDotInput(text, activeDotCommands);

		// When session is locked, only .new and .session commands are allowed
		if (sessionLocked) {
			const isNewCmd =
				(parsed?.mode === "args" && parsed.command === "new") ||
				(parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0]?.name === "new");
			const isSessionCmd =
				(parsed?.mode === "args" && parsed.command === "session") ||
				(parsed?.mode === "select" && parsed.matches.length === 1 && parsed.matches[0]?.name === "session");
			if (!isNewCmd && !isSessionCmd) {
				clearInput();
				return;
			}
		}

		if (parsed?.mode === "args" && parsed.command) {
			if (parsed.command === "stop") {
				handleStopCommand({ sendCancel });
			} else if (parsed.command === "new") {
				handleNewCommand({
					newChat,
					setStagedSkills,
					setStatus,
					defaultStatus: defaultStatus.current,
					setView,
					setTitle,
					pendingNewTitle,
					setWelcomeMarkdown,
					newTitle: (parsed.args ?? "").trim(),
				});
			} else if (parsed.command === "view") {
				handleViewCommand({
					arg: (parsed.args ?? "").trim(),
					setView,
					fetchContext,
					fetchCompactedContext,
				});
			} else if (parsed.command === "session") {
				handleSessionCommand({
					arg: (parsed.args ?? "").trim(),
					sessionList,
					getSessionId,
					loadSession,
					newChat,
					setStagedSkills,
					setStatus,
					defaultStatus: defaultStatus.current,
					setView,
					setVolatileMessage,
				});
			} else if (parsed.command === "subagent") {
				handleSubagentCommand({
					arg: (parsed.args ?? "").trim(),
					subagentList,
					subagents,
					peekSubagentWithScroll,
					peekSubagentFromDbWithScroll,
					setStagedSkills,
					setVolatileMessage,
				});
			} else {
				handleGenericCommand({
					command: parsed.command,
					args: (parsed.args ?? "").trim(),
					getSessionId,
					setSessionId,
					setModel,
					setTitle,
					setStatus,
					setVolatileMessage,
					modelList,
				});
			}
			clearInput();
			return;
		}

		// Single-match select shortcuts: .view, .session, .new, .stop (no space)
		if (parsed?.mode === "select" && parsed.matches.length === 1) {
			const name = parsed.matches[0]?.name;
			if (name === "view") {
				handleViewCommand({ arg: "", setView, fetchContext, fetchCompactedContext });
			} else if (name === "session") {
				handleSessionShortcut({
					viewingSubagentId,
					exitSubagentPeekWithScroll,
					parentId,
					loadSession,
					setStagedSkills,
				});
			} else if (name === "new") {
				handleNewCommand({
					newChat,
					setStagedSkills,
					setStatus,
					defaultStatus: defaultStatus.current,
					setView,
					setTitle,
					pendingNewTitle,
					setWelcomeMarkdown,
					newTitle: "",
				});
			} else if (name === "stop") {
				handleStopCommand({ sendCancel });
			}
			clearInput();
			return;
		}

		// Incomplete or invalid dot command — don't send as prompt
		if (parsed) return;

		// Slash command: stage a skill
		const slashParsed = parseSlashInput(text, skillList, isReadOnly);
		if (slashParsed) {
			if (slashParsed.matches.length === 1) {
				const name = slashParsed.matches[0]?.name;
				if (name) handleSlashCommand({ name, stagedSkills, setStagedSkills });
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
		autoScrollRef.current = true;
		setView((prev) => ({ ...prev, mode: "chat" }));
		setWelcomeMarkdown(null);
		sendPrompt(text, stagedSkills.length > 0 ? stagedSkills : undefined);
		setStagedSkills([]);
		resetHistory();
		clearInput();
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// History navigation takes priority
		if (handleHistoryKeyDown(e)) return;

		if (e.key === "Enter") {
			// Dot commands: submit on any Enter (no modifier check, never multiline)
			if (parseDotInput(input, activeDotCommands)) {
				e.preventDefault();
				submit();
				return;
			}
			// Slash commands: submit on any Enter (like dot commands) — blocked during streaming
			if (!isStreaming && parseSlashInput(input, skillList, isReadOnly)) {
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
			if (parseDotInput(input, activeDotCommands) || (!isStreaming && parseSlashInput(input, skillList, isReadOnly))) {
				submit();
			}
		}
	}

	function renderDotPanel() {
		const parsed = parseDotInput(input, activeDotCommands);
		if (!parsed) return null;

		let content: React.ReactNode;

		if (parsed.mode === "select") {
			content =
				parsed.matches.length > 0 ? (
					parsed.matches.map((cmd) => (
						<div key={cmd.name} className="slash-skill-row">
							{cmd.name} <span className="slash-skill-desc">— {cmd.description}</span>
						</div>
					))
				) : (
					<div>No matching commands</div>
				);
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
				const SESSION_DISPLAY_LIMIT = 32;
				const argText = (parsed.args ?? "").trim();
				const argParts = argText.split(/\s+/);
				const indexPart = argParts[0] ?? "";
				const subcommand = argParts[1];
				const filtered = indexPart ? sessionList.filter((s) => String(s.index).includes(indexPart)) : sessionList;

				// If user typed "N delete", show a delete preview instead of the session list
				if (subcommand === "delete") {
					const idx = Number.parseInt(indexPart, 10);
					const target = !Number.isNaN(idx) ? sessionList.find((s) => s.index === idx) : undefined;
					if (target) {
						const label = target.title ? `"${target.title}"` : `#${target.index}`;
						content = `Delete session ${label}`;
					} else {
						content = `Invalid session index: ${indexPart}`;
					}
				} else {
					const display = filtered.slice(0, SESSION_DISPLAY_LIMIT);
					const maxIndex = Math.max(...display.map((s) => s.index));
					const padWidth = String(maxIndex).length;
					content =
						display.length > 0 ? (
							display.map((s) => {
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
								const paddedIndex = String(s.index).padStart(padWidth, " ");
								return (
									<div key={s.id}>
										{paddedIndex}: {localTime} {s.title ?? ""}
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
				const SUBAGENT_DISPLAY_LIMIT = 32;
				const indexPart = (parsed.args ?? "").trim();
				const filtered = indexPart ? subagentList.filter((s) => String(s.index).includes(indexPart)) : subagentList;
				const display = filtered.slice(0, SUBAGENT_DISPLAY_LIMIT);
				const maxIndex = display.length > 0 ? Math.max(...display.map((s) => s.index)) : 0;
				const padWidth = String(maxIndex).length;
				content =
					display.length > 0 ? (
						display.map((s) => {
							const paddedIndex = String(s.index).padStart(padWidth, " ");
							return (
								<div key={s.sessionId}>
									{paddedIndex}: {s.title}
								</div>
							);
						})
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
		const parsed = parseSlashInput(input, skillList, isReadOnly);
		if (!parsed) return null;

		const content =
			parsed.matches.length > 0 ? (
				parsed.matches.map((s) => (
					<div key={s.name} className="slash-skill-row">
						{s.name} <span className="slash-skill-desc">— {s.description}</span>
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
				const isSubagentView = viewingSubagentId !== null || parentId !== null;
				elements.push(
					<div key={key++} className="panel panel--user">
						{isSubagentView ? <Markdown>{msg.text}</Markdown> : msg.text}
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
						<ToolPanel key={key++} content={panel.content} onNavigate={onNavigate} observe={shouldObserve}>
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
	const peekingSubagentTitle = viewingSubagentId
		? (viewingSubagentTitle ?? subagents.find((s) => s.sessionId === viewingSubagentId)?.title ?? null)
		: null;

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
							{peekingSubagentTitle !== null ? (
								<span className="status-bar-title">
									{" "}
									| {title ?? "(untitled)"} | {peekingSubagentTitle}
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
				{welcomeMarkdown && messages.length === 0 && (
					<div className="panel panel--assistant">
						<Markdown>{welcomeMarkdown}</Markdown>
					</div>
				)}
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
