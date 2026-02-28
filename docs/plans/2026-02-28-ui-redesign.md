# UI Redesign Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Redesign the Bob AI chat UI with a terminal-inspired dark theme, CSS custom properties for future theming, Space Mono font, OpenCode-style layout (status bar / scrollable messages / prompt), and improved input UX.

**Architecture:** Three-zone layout (status bar, messages, prompt) using CSS files with custom properties for colors. No inline styles. Textarea replaces input element with auto-grow behavior. Enter adds newline, Shift+Enter sends.

**Tech Stack:** React 19, CSS custom properties, Google Fonts (Space Mono), Vite

---

### Task 1: Add Space Mono font and create CSS theme file

**Files:**
- Modify: `packages/ui/index.html`
- Create: `packages/ui/src/styles/theme.css`

**Step 1: Add Google Fonts link to index.html**

In `packages/ui/index.html`, add inside `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet" />
```

**Step 2: Create theme.css with CSS custom properties**

Create `packages/ui/src/styles/theme.css`:

```css
:root {
  /* Background colors */
  --bg-primary: #000000;
  --bg-user-message: #1a1a1a;
  --bg-assistant-message: #0a0a0a;
  --bg-input: #1a1a1a;
  --bg-status-bar: #0a0a0a;

  /* Text colors */
  --text-primary: #e0e0e0;
  --text-user: #ffffff;
  --text-assistant: #e0e0e0;
  --text-thinking: #888888;
  --text-muted: #666666;
  --text-status: #888888;
  --text-error: #ff6b6b;

  /* Accent colors */
  --accent-tool-call: #888888;
  --accent-tool-success: #4caf50;
  --accent-tool-error: #ff6b6b;

  /* Typography */
  --font-family: "Space Mono", monospace;
  --font-size-base: 14px;
  --font-size-small: 12px;
  --font-size-status: 11px;

  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
}
```

**Step 3: Verify font loads**

Import theme.css in `packages/ui/src/main.tsx` and verify in browser that Space Mono loads.

**Step 4: Commit**

```
feat(ui): add Space Mono font and CSS theme variables
```

---

### Task 2: Create app layout CSS and refactor main.tsx

**Files:**
- Create: `packages/ui/src/styles/app.css`
- Modify: `packages/ui/src/main.tsx`

**Step 1: Create app.css with global reset and layout**

Create `packages/ui/src/styles/app.css`:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #root {
  height: 100%;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: var(--font-size-base);
}

/* Three-zone layout */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Status bar */
.status-bar {
  padding: var(--spacing-xs) var(--spacing-md);
  background: var(--bg-status-bar);
  font-size: var(--font-size-status);
  color: var(--text-status);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.status-bar .status-indicator {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.status-bar .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-tool-success);
}

.status-bar .status-dot.disconnected {
  background: var(--text-error);
}

/* Message area */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm) 0;
  display: flex;
  flex-direction: column;
}

/* Message panels */
.message {
  padding: var(--spacing-md);
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.5;
}

.message--user {
  background: var(--bg-user-message);
  color: var(--text-user);
}

.message--assistant {
  background: var(--bg-assistant-message);
  color: var(--text-assistant);
}

.message--status {
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-small);
  color: var(--text-muted);
  background: var(--bg-assistant-message);
}

/* Prompt area */
.prompt {
  flex-shrink: 0;
  padding: var(--spacing-md);
}

.prompt-input {
  width: 100%;
  background: var(--bg-input);
  color: var(--text-user);
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  border: none;
  outline: none;
  padding: var(--spacing-md);
  resize: none;
  line-height: 1.5;
  min-height: calc(var(--font-size-base) * 1.5 + var(--spacing-md) * 2);
  max-height: 40vh;
  overflow-y: auto;
}

.prompt-input::placeholder {
  color: var(--text-muted);
}

.prompt-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.prompt-hint {
  font-size: var(--font-size-status);
  color: var(--text-muted);
  padding-top: var(--spacing-xs);
  text-align: right;
}
```

**Step 2: Update main.tsx to import CSS files**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/theme.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
```

**Step 3: Commit**

```
feat(ui): add app layout CSS with three-zone layout
```

---

### Task 3: Rewrite App.tsx with new layout and textarea

**Files:**
- Modify: `packages/ui/src/App.tsx`

**Step 1: Rewrite App.tsx**

Replace entire content of `packages/ui/src/App.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "./useWebSocket";

export function App() {
	const { messages, connected, isStreaming, sendPrompt, newChat } = useWebSocket();
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Auto-resize textarea
	const adjustTextareaHeight = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${textarea.scrollHeight}px`;
	}, []);

	useEffect(() => {
		adjustTextareaHeight();
	}, [input, adjustTextareaHeight]);

	function submit() {
		const text = input.trim();
		if (!text || !connected) return;
		sendPrompt(text);
		setInput("");
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	return (
		<div className="app">
			<div className="status-bar">
				<span>Bob AI</span>
				<div className="status-indicator">
					<span className={`status-dot ${connected ? "" : "disconnected"}`} />
					<span>{connected ? "connected" : "connecting..."}</span>
				</div>
				<button
					type="button"
					className="new-chat-btn"
					onClick={newChat}
					disabled={!connected || messages.length === 0 || isStreaming}
				>
					New Chat
				</button>
			</div>

			<div className="messages">
				{messages.map((msg, i) => (
					<div
						key={i}
						className={`message message--${msg.role}`}
					>
						{msg.text}
					</div>
				))}
				{messages.length > 0 && messages.at(-1)?.role === "assistant" && !isStreaming && (
					<div className="message--status">
						model: gpt-4.1
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<div className="prompt">
				<textarea
					ref={textareaRef}
					className="prompt-input"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={connected ? "Type a message... (Shift+Enter to send)" : "Connecting..."}
					disabled={!connected || isStreaming}
					rows={1}
				/>
				<div className="prompt-hint">
					{isStreaming ? "Generating..." : "Shift+Enter to send"}
				</div>
			</div>
		</div>
	);
}
```

Key changes:
- Three-zone layout with CSS classes (no inline styles)
- Status bar with connection dot and "New Chat" button
- Messages area: full-width panels, user = `message--user`, assistant = `message--assistant`
- Status line after completed assistant message (hard-coded model for now)
- Textarea with auto-grow via `adjustTextareaHeight`
- `Enter` = newline (default textarea behavior), `Shift+Enter` = send
- No send button
- Auto-scroll via `useEffect` on messages change (replaces setTimeout hack)

**Step 2: Verify in browser**

Run `bun run dev` in packages/ui and verify:
- Three-zone layout fills viewport
- Dark theme colors applied
- Space Mono font renders
- Messages display as full-width panels with subtle bg difference
- Textarea grows as you type
- Shift+Enter sends, Enter adds newline
- No send button visible

**Step 3: Commit**

```
feat(ui): rewrite App.tsx with terminal-style chat layout
```

---

### Task 4: Style the New Chat button and add scrollbar styling

**Files:**
- Modify: `packages/ui/src/styles/app.css`

**Step 1: Add button and scrollbar styles to app.css**

Append to `packages/ui/src/styles/app.css`:

```css
/* Buttons */
.new-chat-btn {
  background: transparent;
  color: var(--text-status);
  border: 1px solid var(--text-muted);
  font-family: var(--font-family);
  font-size: var(--font-size-status);
  padding: var(--spacing-xs) var(--spacing-sm);
  cursor: pointer;
}

.new-chat-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-primary);
}

.new-chat-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Scrollbar */
.messages::-webkit-scrollbar {
  width: 6px;
}

.messages::-webkit-scrollbar-track {
  background: transparent;
}

.messages::-webkit-scrollbar-thumb {
  background: var(--text-muted);
  border-radius: 3px;
}

.messages::-webkit-scrollbar-thumb:hover {
  background: var(--text-status);
}
```

**Step 2: Commit**

```
feat(ui): add button and scrollbar styles
```

---

### Task 5: Add model name to done message (server-side)

**Files:**
- Modify: `packages/server/src/protocol.ts:9` — add `model` to `done` type
- Modify: `packages/server/src/handler.ts:97` — include `model` in done message
- Modify: `packages/ui/src/useWebSocket.ts:7,10,60-63` — store model from done, expose it

**Step 1: Update ServerMessage type in protocol.ts**

Change line 9 in `packages/server/src/protocol.ts`:
```ts
	| { type: "done"; sessionId: string; model: string }
```

**Step 2: Include model in done message in handler.ts**

Change line 97 in `packages/server/src/handler.ts`:
```ts
		send(ws, { type: "done", sessionId: currentSessionId, model });
```

**Step 3: Update useWebSocket to expose model**

In `packages/ui/src/useWebSocket.ts`:
- Update the `done` type in `ServerMessage` to include `model: string`
- Add `model` state: `const [model, setModel] = useState<string | null>(null);`
- In the `done` handler: `setModel(msg.model);`
- Return `model` from the hook

**Step 4: Update App.tsx to use dynamic model**

In `packages/ui/src/App.tsx`, replace the hard-coded `model: gpt-4.1` with `model` from `useWebSocket()`.

**Step 5: Run server tests**

```bash
bun test packages/server/test/
```

All existing tests should still pass (handler tests mock `send` and don't assert on `done` message fields beyond `type` and `sessionId` — verify this).

**Step 6: Commit**

```
feat: include model name in done message and display in UI
```

---

### Task 6: Visual polish and verify

**Files:**
- Possibly tweak: `packages/ui/src/styles/theme.css`, `packages/ui/src/styles/app.css`

**Step 1: Build the UI**

```bash
bun run build
```
in `packages/ui/` to verify no build errors.

**Step 2: Manual visual check**

Run the full app and verify:
- Dark terminal-like appearance
- Space Mono font throughout
- Three-zone layout (status bar, messages, prompt)
- User messages: dark gray bg, white text
- Assistant messages: black bg, light gray text
- Status line shows model name after assistant response
- Textarea auto-grows, max 40vh then scrolls
- Shift+Enter sends, Enter adds newline
- No send button
- Connection dot green when connected, red when disconnected
- New Chat button styled minimally
- Scrollbar subtle and dark-themed

**Step 3: Commit any final tweaks**

```
style(ui): visual polish adjustments
```
