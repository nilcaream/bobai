import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import type { MessagePart } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

function UnifiedDiff({ oldString, newString }: { oldString: string; newString: string }) {
	const oldLines = oldString.split("\n");
	const newLines = newString.split("\n");
	return (
		<div className="diff">
			{oldLines.map((line, i) => (
				<div key={`old-${i}-${line}`} className="diff-removed">
					{`- ${line}`}
				</div>
			))}
			{newLines.map((line, i) => (
				<div key={`new-${i}-${line}`} className="diff-added">
					{`+ ${line}`}
				</div>
			))}
		</div>
	);
}

type ToolCall = { id: string; label: string };

type Panel =
	| { type: "text"; content: string }
	| {
			type: "tool";
			name: string;
			calls: ToolCall[];
			result?: string;
			isError?: boolean;
			quiet?: boolean;
			diff?: { oldString: string; newString: string };
	  };

const quietTools = new Set(["read_file", "write_file", "list_directory", "grep_search"]);

function formatQuietSuffix(name: string, metadata?: Record<string, unknown>): string {
	if (!metadata) return "";
	if (name === "read_file") {
		const n = metadata.linesRead;
		if (typeof n !== "number") return "";
		return `(${n} ${n === 1 ? "line" : "lines"})`;
	}
	if (name === "write_file") {
		const n = metadata.bytesWritten;
		if (typeof n !== "number") return "";
		return `(${n} bytes)`;
	}
	if (name === "list_directory") {
		const n = metadata.entryCount;
		if (typeof n !== "number") return "";
		return `(${n} ${n === 1 ? "entry" : "entries"})`;
	}
	if (name === "grep_search") {
		const n = metadata.matchCount;
		if (typeof n !== "number") return "";
		if (n === 0) return "(no results)";
		return `(${n} ${n === 1 ? "result" : "results"})`;
	}
	return "";
}

function groupParts(parts: MessagePart[]): Panel[] {
	const panels: Panel[] = [];
	const callIndex = new Map<string, { panel: Panel & { type: "tool" }; callIdx: number }>();

	for (const part of parts) {
		if (part.type === "text") {
			panels.push({ type: "text", content: part.content });
		} else if (part.type === "tool_call") {
			const isQuiet = quietTools.has(part.name);
			const last = panels.at(-1);
			const call: ToolCall = { id: part.id, label: part.content };

			if (last?.type === "tool" && last.quiet && isQuiet) {
				// Merge into existing quiet panel
				last.calls.push(call);
				callIndex.set(part.id, { panel: last, callIdx: last.calls.length - 1 });
			} else {
				const diff =
					part.oldString != null && part.newString != null
						? { oldString: part.oldString, newString: part.newString }
						: undefined;
				const panel = { type: "tool" as const, name: part.name, calls: [call], diff, quiet: isQuiet };
				panels.push(panel);
				callIndex.set(part.id, { panel, callIdx: 0 });
			}
		} else if (part.type === "tool_result") {
			const entry = callIndex.get(part.id);
			if (!entry) continue;

			if (entry.panel.quiet) {
				// Quiet tool: update the call label with result info
				if (part.isError) {
					entry.panel.calls[entry.callIdx].label += " (error)";
				} else {
					const suffix = formatQuietSuffix(part.name, part.metadata);
					if (suffix) {
						entry.panel.calls[entry.callIdx].label += ` ${suffix}`;
					}
				}
			} else if (part.name === "edit_file") {
				// edit_file: suppress text result (diff shown instead)
			} else {
				// Non-quiet: show result as block
				entry.panel.result = part.content;
				entry.panel.isError = part.isError;
			}
		}
	}
	return panels;
}

export function App() {
	const { messages, connected, isStreaming, sendPrompt, model } = useWebSocket();
	const [input, setInput] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
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

	function submit() {
		const text = input.trim();
		if (!text || !connected || isStreaming) return;
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

		if (e.key === "Enter" && e.shiftKey) {
			e.preventDefault();
			submit();
		}
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
									{model ? ` | ${model}` : ""}
								</div>
							)}
						</div>,
					);
				} else {
					elements.push(
						<div key={key++} className="panel panel--tool">
							{panel.calls.map((call) => (
								<div key={call.id} className="tool-call">
									{call.label}
								</div>
							))}
							{panel.diff && <UnifiedDiff oldString={panel.diff.oldString} newString={panel.diff.newString} />}
							{panel.result != null && (
								<div className={panel.isError ? "tool-result tool-result--error" : "tool-result"}>{panel.result}</div>
							)}
							{isLast && msg.timestamp && (
								<div className="panel-status">
									{msg.timestamp}
									{model ? ` | ${model}` : ""}
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
				<span className="status-bar-label">Bob AI</span>
				<span className={`status-dot${connected ? "" : " disconnected"}`} />
				<span>{connected ? "connected" : "connecting..."}</span>
			</div>

			<div className="messages" role="log" aria-live="polite" ref={messagesRef}>
				{renderPanels()}
			</div>

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
