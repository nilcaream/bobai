import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import type { MessagePart } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

type Panel =
	| { type: "text"; content: string }
	| { type: "tool"; id: string; content: string; completed: boolean; mergeable: boolean };

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

export function App() {
	const {
		messages,
		connected,
		isStreaming,
		sendPrompt,
		setModel,
		title,
		setTitle,
		status,
		setStatus,
		addErrorMessage,
		getSessionId,
		setSessionId,
	} = useWebSocket();
	const [input, setInput] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [modelList, setModelList] = useState<{ index: number; id: string; cost: string }[] | null>(null);
	const historyEntries = useRef<string[]>([]);
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
			textareaRef.current?.focus();
		}
	}, [isStreaming, connected]);

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}, []);

	// Adjust textarea height when navigating history
	// biome-ignore lint/correctness/useExhaustiveDependencies: adjustHeight is stable via useCallback
	useEffect(() => {
		requestAnimationFrame(adjustHeight);
	}, [historyIndex]);

	const DOT_COMMANDS = ["model", "session", "title"] as const;

	function parseDotInput(text: string) {
		if (!text.startsWith(".")) return null;
		const withoutDot = text.slice(1);
		const spaceIndex = withoutDot.indexOf(" ");
		if (spaceIndex === -1) {
			const prefix = withoutDot.toLowerCase();
			const matches = DOT_COMMANDS.filter((c) => c.startsWith(prefix));
			return { mode: "select" as const, prefix, matches, args: "", command: undefined };
		}
		const cmdPart = withoutDot.slice(0, spaceIndex).toLowerCase();
		const matches = DOT_COMMANDS.filter((c) => c.startsWith(cmdPart));
		if (matches.length === 1) {
			return { mode: "args" as const, prefix: cmdPart, matches, args: withoutDot.slice(spaceIndex + 1), command: matches[0] };
		}
		return { mode: "select" as const, prefix: cmdPart, matches, args: "", command: undefined };
	}

	// Fetch models eagerly on mount — needed for status bar and dot panel
	// biome-ignore lint/correctness/useExhaustiveDependencies: setModel/setStatus are stable React state setters
	useEffect(() => {
		fetch("/bobai/models")
			.then((res) => res.json())
			.then((data: { models: { index: number; id: string; cost: string }[]; defaultModel: string; defaultStatus: string }) => {
				setModelList(data.models);
				setModel((prev) => prev ?? data.defaultModel);
				setStatus((prev) => prev || data.defaultStatus);
			})
			.catch(() => {});
	}, []);

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;

		const parsed = parseDotInput(text);
		if (parsed?.mode === "args" && parsed.command) {
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
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
			return;
		}

		// Incomplete or invalid dot command — don't send as prompt
		if (parsed) return;

		if (isStreaming) return;
		autoScroll.current = true;
		sendPrompt(text);
		setInput("");
		setHistoryIndex(-1);
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
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
			// Regular prompts: Shift+Enter to submit, bare Enter for newline
			if (e.shiftKey) {
				e.preventDefault();
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
		} else if (parsed.command === "title") {
			const titleText = parsed.args.trim();
			content = titleText ? `Set session title: ${titleText}` : "Enter session title";
		} else if (parsed.command === "session") {
			content = "Session switching is not implemented yet";
		} else {
			return null;
		}

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
			const msgSummary = msg.summary ?? (msg.model ? ` | ${msg.model}` : "");
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
							{isLast && msg.timestamp && (
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

	return (
		<main className="app">
			<div className="panel panel--status-bar">
				<span>
					<span className="status-bar-label">Bob AI</span> <span className={`status-dot${connected ? "" : " disconnected"}`} />{" "}
					{connected ? "connected" : "connecting..."}
					{title && <span className="status-bar-title"> {title}</span>}
				</span>
				<span>{status}</span>
			</div>

			<div className="messages" role="log" aria-live="polite" ref={messagesRef}>
				{renderPanels()}
			</div>

			{renderDotPanel()}

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
					placeholder="Type a message..."
					disabled={!connected || isStreaming}
				/>
			</div>
		</main>
	);
}
