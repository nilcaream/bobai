import type React from "react";
import { useEffect } from "react";

/**
 * Registers document-level keyboard event listeners:
 * - PageUp / PageDown scrolls the messages panel
 * - Printable keystrokes redirect to the prompt textarea when unfocused
 * - Escape exits subagent peek
 * - Refocuses the prompt textarea when streaming ends
 */
export function useGlobalKeyboard(
	messagesRef: React.RefObject<HTMLDivElement | null>,
	textareaRef: React.RefObject<HTMLTextAreaElement | null>,
	viewingSubagentId: string | null,
	exitSubagentPeekWithScroll: () => void,
	isStreaming: boolean,
	connected: boolean,
): void {
	// PAGE UP/DOWN scrolls the messages panel globally (works even during streaming)
	// biome-ignore lint/correctness/useExhaustiveDependencies: messagesRef is a stable ref object from useAutoScroll
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
			// autoScroll state is handled by the scroll listener in useAutoScroll
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Refocus the prompt textarea when streaming ends
	// biome-ignore lint/correctness/useExhaustiveDependencies: textareaRef is a stable ref object; .current should not be a dependency
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: textareaRef is a stable ref object; .current should not be a dependency
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
}
