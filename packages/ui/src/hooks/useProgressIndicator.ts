import { useCallback, useEffect, useState } from "react";
import { formatProgress, IDLE, onEvent, type ProgressState } from "../progressIndicator";
import type { ServerMessage } from "../protocol";

const TICK_MS = 100;

export function useProgressIndicator() {
	const [state, setState] = useState<ProgressState>(IDLE);
	const [now, setNow] = useState(() => Date.now());

	// Refresh the clock while a phase is active so time-based phases tick.
	useEffect(() => {
		if (state.phase === "idle") return;
		const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
		return () => window.clearInterval(id);
	}, [state.phase]);

	const observe = useCallback((msg: ServerMessage) => {
		setState((prev) => onEvent(prev, msg, Date.now()));
	}, []);

	const beginWaiting = useCallback(() => {
		const t = Date.now();
		setState({ phase: "waiting", startedAt: t });
		setNow(t);
	}, []);

	const reset = useCallback(() => {
		setState(IDLE);
		setNow(Date.now());
	}, []);

	return { progressText: formatProgress(state, now), observe, beginWaiting, reset };
}
