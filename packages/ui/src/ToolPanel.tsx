import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Panels taller than COLLAPSE_LINES are auto-collapsed (CSS max-height clips
 * the .md child). With monospace font and line-height: 1, 1 em = 1 line.
 */
export const COLLAPSE_LINES = 6;

/**
 * Wraps a tool-call panel with collapse/expand behaviour.
 *
 * Collapse detection: after mount, compare the rendered `.md` child's
 * scrollHeight against COLLAPSE_LINES × font-size. If content overflows,
 * the panel auto-collapses (CSS `max-height: 6em` clips the overflow).
 * Double-click toggles between collapsed and expanded states.
 *
 * The `content` prop is the raw markdown string — it is NOT rendered here
 * (children handles that) but is included as an effect dependency so the
 * overflow check re-runs when React reuses this component instance for
 * different content. This happens when positional keys (key={n}) collide
 * across view transitions (e.g. parent → subagent).
 * See FINDINGS.md "React key reuse across view transitions".
 */
export function ToolPanel({
	children,
	content,
	onNavigate,
	observe,
}: {
	children: React.ReactNode;
	/** Raw markdown — used as a signal dep for re-measurement, not rendered. */
	content: string;
	onNavigate?: () => void;
	/** True while the tool is actively streaming (skip measurement). */
	observe?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState<boolean | null>(null);
	const collapsible = useRef(false);
	const userToggled = useRef(false);
	const prevContent = useRef(content);

	const checkOverflow = useCallback(() => {
		if (!ref.current) return;
		const md = ref.current.querySelector(".md");
		if (!md) return;
		const lineHeight = parseFloat(getComputedStyle(md).fontSize);
		// Small tolerance so <hr> borders (1px each) don't push a
		// panel that fits in COLLAPSE_LINES over the threshold.
		const maxHeight = lineHeight * COLLAPSE_LINES + 4;
		const overflows = md.scrollHeight > maxHeight;
		collapsible.current = overflows;
		setCollapsed(overflows);
	}, []);

	// Re-measure when content changes (e.g. key reuse across parent/subagent
	// views — see ToolPanel JSDoc). Respect userToggled for same-content
	// re-renders so a manual expand/collapse is preserved during streaming.
	useEffect(() => {
		if (observe) return;
		const contentChanged = prevContent.current !== content;
		prevContent.current = content;
		// Content swap (key reuse across views) — reset user toggle
		// so the new content gets a fresh measurement.
		if (contentChanged) userToggled.current = false;
		if (userToggled.current) return;
		checkOverflow();
	}, [observe, content, checkOverflow]);

	const handleDoubleClick = () => {
		if (onNavigate) {
			onNavigate();
			window.getSelection()?.removeAllRanges();
			return;
		}
		if (collapsible.current) {
			userToggled.current = true;
			setCollapsed((prev) => !prev);
			window.getSelection()?.removeAllRanges();
		}
	};

	const isExpanded = collapsible.current && !collapsed;
	const cls = `panel panel--tool${collapsed ? " panel--collapsed" : ""}${isExpanded ? " panel--expanded" : ""}${onNavigate ? " panel--navigable" : ""}`;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click fold is a convenience shortcut, not primary interaction
		<div ref={ref} className={cls} onDoubleClick={handleDoubleClick}>
			{children}
		</div>
	);
}
