import { useEffect, useRef } from "react";
import { parseSessionUrl } from "../urlUtils";

export function useSessionRouting(
	loadSession: (id: string, opts?: { skipUrlUpdate?: boolean }) => Promise<boolean>,
	newChat: () => void,
	setWelcomeMarkdown: (md: string | null) => void,
	addVolatileMessage: (text: string, kind: "error" | "success" | "info") => void,
	isStreaming: boolean,
	connected: boolean,
	getSessionId: () => string | null,
) {
	const pendingNewTitle = useRef<string | null>(null);

	// Load session from URL or show welcome screen
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadSession is stable via useCallback
	useEffect(() => {
		const { sessionId: urlSessionId } = parseSessionUrl(window.location.pathname);
		if (urlSessionId) {
			loadSession(urlSessionId, { skipUrlUpdate: true }).then((success) => {
				if (!success) {
					addVolatileMessage("Session not found", "error");
				}
			});
		} else {
			fetch("/bobai/welcome")
				.then((res) => res.json())
				.then((data: { markdown: string }) => {
					if (data?.markdown) {
						setWelcomeMarkdown(data.markdown);
					}
				})
				.catch(() => {});
		}
	}, []);

	// Handle browser back/forward navigation
	useEffect(() => {
		const onPopState = () => {
			const { sessionId: urlSessionId } = parseSessionUrl(window.location.pathname);
			if (urlSessionId) {
				loadSession(urlSessionId, { skipUrlUpdate: true });
			} else {
				newChat();
				fetch("/bobai/welcome")
					.then((res) => res.json())
					.then((data: { markdown: string }) => {
						if (data?.markdown) setWelcomeMarkdown(data.markdown);
					})
					.catch(() => {});
			}
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [loadSession, newChat, setWelcomeMarkdown]);

	// Persist pending title from `.new <title>` after first prompt creates the session
	useEffect(() => {
		if (isStreaming || !connected) return;
		const pendingTitle = pendingNewTitle.current;
		if (!pendingTitle) return;
		const sid = getSessionId();
		if (!sid) return;
		// Clear only after confirming we have a sessionId — otherwise the effect
		// would fire immediately after `.new` (isStreaming=false, sid=null) and
		// discard the title before the first prompt creates the session.
		pendingNewTitle.current = null;
		fetch("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "title", args: pendingTitle, sessionId: sid }),
		}).catch(() => {});
	}, [isStreaming, connected, getSessionId]);

	return {
		pendingNewTitle,
	};
}
