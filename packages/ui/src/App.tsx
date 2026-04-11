import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessageList } from "./ChatMessageList";
import { ContextMessageList } from "./ContextMessageList";
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
import { DotCommandPanel } from "./DotCommandPanel";
import type { CompactionDetail, CompactionStats, ContextMessage } from "./formatUtils";
import { useAutoScroll } from "./hooks/useAutoScroll";
import { useGlobalKeyboard } from "./hooks/useGlobalKeyboard";
import { useInputHistory } from "./hooks/useInputHistory";
import { useSessionRouting } from "./hooks/useSessionRouting";
import { Markdown } from "./Markdown";
import type { StagedSkill } from "./protocol";
import { SlashCommandPanel } from "./SlashCommandPanel";
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
					setView,
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

	const parsedDotInput = parseDotInput(input, activeDotCommands);
	const parsedSlashInput = parseSlashInput(input, skillList, isReadOnly);

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
					(view.mode === "chat" ? (
						<ChatMessageList
							messages={messages}
							subagents={subagents}
							isStreaming={isStreaming}
							viewingSubagentId={viewingSubagentId}
							parentId={parentId}
							peekSubagentWithScroll={peekSubagentWithScroll}
							peekSubagentFromDbWithScroll={peekSubagentFromDbWithScroll}
						/>
					) : (
						<ContextMessageList
							contextMessages={contextMessages}
							compactionData={compactionData}
							viewMode={view.mode}
							lineLimit={view.lineLimit}
						/>
					))}
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
			<DotCommandPanel
				parsed={parsedDotInput}
				modelList={modelList}
				sessionList={sessionList}
				subagentList={subagentList}
				getSessionId={getSessionId}
				sessionLocked={sessionLocked}
			/>
			<SlashCommandPanel parsed={parsedSlashInput} />

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
