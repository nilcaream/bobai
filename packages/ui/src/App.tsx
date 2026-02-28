import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import type { MessagePart } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

type Panel =
	| { type: "text"; content: string }
	| { type: "tool"; name: string; calls: string[]; result?: string; isError?: boolean };

function groupParts(parts: MessagePart[]): Panel[] {
	const panels: Panel[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			panels.push({ type: "text", content: part.content });
		} else if (part.type === "tool_call") {
			const last = panels.at(-1);
			if (last?.type === "tool" && last.name === "read_file" && part.name === "read_file") {
				last.calls.push(part.content);
			} else {
				panels.push({ type: "tool", name: part.name, calls: [part.content] });
			}
		} else if (part.type === "tool_result") {
			const last = panels.at(-1);
			if (last?.type === "tool") {
				if (part.name === "read_file") {
					// Suppress file content display for read_file
				} else {
					last.result = part.content;
					last.isError = part.isError;
				}
			}
		}
	}
	return panels;
}

export function App() {
	const { messages, connected, isStreaming, sendPrompt, model } = useWebSocket();
	const [input, setInput] = useState("");
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

	function submit() {
		const text = input.trim();
		if (!text || !connected || isStreaming) return;
		autoScroll.current = true;
		sendPrompt(text);
		setInput("");
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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
								<div key={call} className="tool-call">
									{call}
								</div>
							))}
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
					className="prompt-input"
					rows={1}
					spellCheck={false}
					value={input}
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
