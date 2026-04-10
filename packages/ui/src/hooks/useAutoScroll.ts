import { useCallback, useEffect, useRef } from "react";
import type { ViewMode } from "../commandParser";
import type { Message } from "../protocol";

export function useAutoScroll(
	messages: Message[],
	peekSubagent: (childSessionId: string) => void,
	peekSubagentFromDb: (childSessionId: string) => void,
	exitSubagentPeek: () => void,
	setView: React.Dispatch<React.SetStateAction<{ mode: ViewMode; lineLimit: number }>>,
) {
	const messagesRef = useRef<HTMLDivElement>(null);
	const autoScrollRef = useRef(true);
	const savedScrollTop = useRef<number | null>(null);

	// Wrap peekSubagent to save scroll position before switching to child view
	const peekSubagentWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			setView((prev) => ({ ...prev, mode: "chat" }));
			peekSubagent(childSessionId);
		},
		[peekSubagent, setView],
	);

	// Wrap peekSubagentFromDb to save scroll position before switching to child view
	const peekSubagentFromDbWithScroll = useCallback(
		(childSessionId: string) => {
			savedScrollTop.current = messagesRef.current?.scrollTop ?? null;
			setView((prev) => ({ ...prev, mode: "chat" }));
			peekSubagentFromDb(childSessionId);
		},
		[peekSubagentFromDb, setView],
	);

	// Wrap exitSubagentPeek to restore scroll position after returning to parent view
	const exitSubagentPeekWithScroll = useCallback(() => {
		const scrollPos = savedScrollTop.current;
		setView((prev) => ({ ...prev, mode: "chat" }));
		exitSubagentPeek();
		if (scrollPos !== null) {
			autoScrollRef.current = false;
			requestAnimationFrame(() => {
				const el = messagesRef.current;
				if (el) el.scrollTop = scrollPos;
			});
			savedScrollTop.current = null;
		}
	}, [exitSubagentPeek, setView]);

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
	}, []);

	// Scroll to bottom on new content when autoscroll is active
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll even though ref is used
	useEffect(() => {
		if (!autoScrollRef.current) return;
		const el = messagesRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	return {
		messagesRef,
		autoScrollRef,
		peekSubagentWithScroll,
		peekSubagentFromDbWithScroll,
		exitSubagentPeekWithScroll,
	};
}
