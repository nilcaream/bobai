import { useCallback, useEffect, useRef } from "react";
import type { ViewMode } from "../commandParser";
import type { Message } from "../protocol";

export function useAutoScroll(
	messages: Message[],
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

	// ResizeObserver-based autoscroll: fires whenever the scroll container's
	// content height changes (new messages, Markdown rendering, code block
	// expansion, image loads, tool results arriving late, etc.).
	// Supplements the useEffect([messages]) fallback below: that effect only
	// fires on React state changes and misses layout-driven growth (e.g. large
	// bash outputs rendering after the React commit).
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			if (!autoScrollRef.current) return;
			el.scrollTop = el.scrollHeight;
		});
		// Observe the container's direct children — when they resize (content
		// grows), the observer fires. We also observe the container itself
		// to catch cases where flex layout changes the container's size.
		ro.observe(el);
		for (const child of el.children) {
			ro.observe(child);
		}
		// MutationObserver to track DOM additions/removals (new panels).
		// ResizeObserver only watches existing elements; new children need
		// to be observed explicitly.
		const mo = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node instanceof Element) ro.observe(node);
				}
			}
			// New nodes were added — scroll to bottom if autoscroll is active
			if (autoScrollRef.current) {
				el.scrollTop = el.scrollHeight;
			}
		});
		mo.observe(el, { childList: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
	}, [autoScrollRef]);

	// Fallback: scroll to bottom when the messages array reference changes.
	// The ResizeObserver handles content growth, but messages array replacement
	// (e.g. session load, peek exit) may not trigger a resize if the new
	// content has similar dimensions. This effect ensures those transitions
	// still scroll to bottom.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll even though ref is used
	useEffect(() => {
		if (!autoScrollRef.current) return;
		const el = messagesRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	return {
		messagesRef,
		scrollToBottom,
		peekSubagentWithScroll,
		peekSubagentFromDbWithScroll,
		exitSubagentPeekWithScroll,
	};
}
