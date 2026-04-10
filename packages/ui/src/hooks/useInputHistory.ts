import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Manages prompt history browsing (ArrowUp/Down to navigate previous prompts).
 *
 * Returns `historyIndex` for UI styling/readOnly state, `resetHistory` to call
 * after submit(), and `handleHistoryKeyDown` — a partial keydown handler that
 * returns `true` when it consumed the event.
 */
export function useInputHistory(input: string, setInput: (value: string) => void, adjustHeight: () => void) {
	const [historyIndex, setHistoryIndex] = useState(-1);
	const savedDraft = useRef("");
	const fetchGen = useRef(0);
	const historyEntries = useRef<string[]>([]);

	// Adjust textarea height when navigating history
	// biome-ignore lint/correctness/useExhaustiveDependencies: adjustHeight is stable via useCallback
	useEffect(() => {
		requestAnimationFrame(adjustHeight);
	}, [historyIndex]);

	const resetHistory = useCallback(() => {
		setHistoryIndex(-1);
	}, []);

	function exitHistory(restoreValue: string) {
		setHistoryIndex(-1);
		setInput(restoreValue);
	}

	function handleHistoryKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
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
				return true;
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
				return true;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				exitHistory(savedDraft.current);
				return true;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				// Copy history entry into input as editable text
				exitHistory(historyEntries.current[historyIndex] ?? "");
				return true;
			}
			return true;
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
			return true;
		}

		return false;
	}

	return {
		historyIndex,
		resetHistory,
		handleHistoryKeyDown,
	};
}
