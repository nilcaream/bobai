import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ViewMode } from "../commandParser";

export function useAutoScroll(
	autoScrollRef: React.MutableRefObject<boolean>,
	peekSubagent: (childSessionId: string) => void,
	peekSubagentFromDb: (childSessionId: string) => void,
	exitSubagentPeek: () => void,
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>,
) {
	const messagesRef = useRef<HTMLDivElement>(null);
	const savedScrollTop = useRef<number | null>(null);

	// Imperative scroll-to-bottom: enable autoscroll and snap immediately.
	// Used by view switching, session loading, and any code path that needs
	// to guarantee the user sees the latest content.
	const scrollToBottom = useCallback(() => {
		autoScrollRef.current = true;
		const el = messagesRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [autoScrollRef]);

	// Wrap peekSubagent to save scroll position before switching to child view
	const peekSubagentWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			autoScrollRef.current = true;
			setView((prev) => ({ ...prev, mode: "chat" }));
			peekSubagent(childSessionId);
		},
		[autoScrollRef, peekSubagent, setView],
	);

	// Wrap peekSubagentFromDb to save scroll position before switching to child view
	const peekSubagentFromDbWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			autoScrollRef.current = true;
			setView((prev) => ({ ...prev, mode: "chat" }));
			peekSubagentFromDb(childSessionId);
		},
		[autoScrollRef, peekSubagentFromDb, setView],
	);

	// Wrap exitSubagentPeek to restore scroll position after returning to parent view
	const exitSubagentPeekWithScroll = useCallback(() => {
		const scrollPos = savedScrollTop.current;
		setView((prev) => ({ ...prev, mode: "chat" }));
		exitSubagentPeek();
		if (scrollPos !== null) {
			autoScrollRef.current = false;
			// Double rAF: first waits for React commit, second waits for layout/paint.
			// This ensures the parent messages are fully rendered before restoring scroll.
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const el = messagesRef.current;
					if (el) el.scrollTop = scrollPos;
				});
			});
			savedScrollTop.current = null;
		}
	}, [autoScrollRef, exitSubagentPeek, setView]);

	// Unified scroll listener: determine autoscroll based on position.
	// Fires on every scroll event (mouse wheel, PageUp/Down, programmatic).
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const THRESHOLD = 2;
		const onScroll = () => {
			const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD;
			autoScrollRef.current = atBottom;
		};
		el.addEventListener("scroll", onScroll);
		return () => el.removeEventListener("scroll", onScroll);
	}, [autoScrollRef]);

	// Auto-scroll: keep the view at the bottom when autoscroll is active.
	// useLayoutEffect fires synchronously after every React DOM commit but
	// before paint. Reading scrollHeight forces a synchronous layout pass,
	// so the value is always up-to-date regardless of what changed (new
	// panels, streaming tokens, tool results, expand/collapse, session loads).
	useLayoutEffect(() => {
		if (!autoScrollRef.current) return;
		const el = messagesRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	});

	return {
		messagesRef,
		scrollToBottom,
		peekSubagentWithScroll,
		peekSubagentFromDbWithScroll,
		exitSubagentPeekWithScroll,
	};
}
