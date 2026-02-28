import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { useWebSocket } from "./useWebSocket";

export function App() {
	const { messages, connected, isStreaming, sendPrompt, newChat, model } = useWebSocket();
	const [input, setInput] = useState("");
	const messagesRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-scroll when messages change, but only if user is near the bottom
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll even though ref is used
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 150) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	// Re-focus textarea when streaming ends
	useEffect(() => {
		if (!isStreaming && connected) {
			textareaRef.current?.focus();
		}
	}, [isStreaming, connected]);

	// Auto-grow textarea
	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	}, []);

	function submit() {
		const text = input.trim();
		if (!text || !connected || isStreaming) return;
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

	return (
		<main className="app">
			<div className="status-bar">
				<span className="status-bar-label">Bob AI</span>
				<span className={`status-dot${connected ? "" : " disconnected"}`} />
				<span>{connected ? "connected" : "connecting..."}</span>
				<button
					type="button"
					className="new-chat-btn"
					onClick={newChat}
					disabled={!connected || messages.length === 0 || isStreaming}
				>
					New Chat
				</button>
			</div>

			<div className="messages" role="log" aria-live="polite" ref={messagesRef}>
				{messages.map((msg, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					<div key={i}>
						<div className={`message message--${msg.role}`}>
							{msg.role === "assistant" ? <Markdown>{msg.text}</Markdown> : msg.text}
						</div>
						{msg.timestamp && (
							<div className={`message--status message--status-${msg.role}`}>
								{msg.timestamp}
								{msg.role === "assistant" && model ? ` | ${model}` : ""}
							</div>
						)}
					</div>
				))}
			</div>

			<div className="prompt">
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
