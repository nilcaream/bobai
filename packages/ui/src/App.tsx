import { useRef, useState } from "react";
import { useWebSocket } from "./useWebSocket";

export function App() {
	const { messages, connected, sendPrompt } = useWebSocket();
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;
		sendPrompt(text);
		setInput("");
		setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
	}

	return (
		<main style={{ display: "flex", flexDirection: "column", height: "100vh", padding: "1rem" }}>
			<header>
				<h1 style={{ margin: 0 }}>Bob AI</h1>
				<small>{connected ? "connected" : "connecting..."}</small>
			</header>

			<section
				style={{
					flex: 1,
					overflowY: "auto",
					padding: "1rem 0",
					display: "flex",
					flexDirection: "column",
					gap: "0.5rem",
				}}
			>
				{messages.map((msg, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						key={i}
						style={{
							alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
							background: msg.role === "user" ? "#0070f3" : "#222",
							color: "#fff",
							borderRadius: "8px",
							padding: "0.5rem 0.75rem",
							maxWidth: "70%",
							whiteSpace: "pre-wrap",
						}}
					>
						{msg.text}
					</div>
				))}
				<div ref={bottomRef} />
			</section>

			<footer style={{ display: "flex", gap: "0.5rem" }}>
				<input
					style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
					placeholder="Type a message..."
					disabled={!connected}
				/>
				<button type="button" onClick={submit} disabled={!connected}>
					Send
				</button>
			</footer>
		</main>
	);
}
