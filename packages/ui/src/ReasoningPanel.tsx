import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/**
 * Reasoning ("thinking") panel.
 *
 * Text is capped at 10 lines and clipped with hidden overflow; the visible
 * window auto-scrolls to the tail as reasoning streams in. With the app's
 * monospace font and line-height: 1, 1em = 1 line, so the cap is
 * `max-height: 10em` — see `.panel--reasoning > .md` in app.css.
 *
 * Panels whose reasoning overflows the cap are collapsible: double-click
 * toggles between collapsed (10-line tail view) and expanded (full text in
 * the normal message flow). This mirrors ToolPanel's collapse/expand
 * affordance (dotted border = collapsed, dashed = expanded) but shares no
 * state with it — the two components are fully independent.
 *
 * `status` (timestamp + model summary) renders BELOW the clipped box, so it
 * stays visible even when the reasoning overflows.
 */
export function ReasoningPanel({ content, status }: { content: string; status?: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState(true);
	const [collapsible, setCollapsible] = useState(false);
	const userToggled = useRef(false);
	const prevContent = useRef(content);

	// Overflow detection: while collapsed, the .md is capped at 10 lines, so
	// scrollHeight (full content) > clientHeight (capped box) means it
	// overflows. Compares actual layout, so it needs no font-size knowledge.
	const checkOverflow = useCallback(() => {
		const md = ref.current?.querySelector(".md");
		if (!md) return;
		const overflows = md.scrollHeight > md.clientHeight + 1;
		setCollapsible(overflows);
		setCollapsed(overflows);
	}, []);

	// Re-measure on content change (each streamed token, or key reuse across
	// view transitions — see FINDINGS.md "React key reuse across view
	// transitions"). Preserve a manual toggle on APPEND (streaming), reset it
	// on REPLACEMENT (key reuse).
	useEffect(() => {
		const oldContent = prevContent.current;
		const contentChanged = oldContent !== content;
		prevContent.current = content;
		if (contentChanged && !content.startsWith(oldContent)) {
			userToggled.current = false;
		}
		if (userToggled.current) return;
		checkOverflow();
	}, [content, checkOverflow]);

	// Auto-scroll to the tail after every commit (each streamed token).
	// useLayoutEffect fires synchronously before paint; running it without a
	// dependency array re-scrolls on every render and is idempotent. When
	// expanded there is no cap, so scrollHeight === clientHeight and this is
	// a no-op.
	useLayoutEffect(() => {
		const md = ref.current?.querySelector(".md");
		if (md) md.scrollTop = md.scrollHeight;
	});

	const handleDoubleClick = () => {
		if (!collapsible) return;
		userToggled.current = true;
		setCollapsed((prev) => !prev);
		window.getSelection()?.removeAllRanges();
	};

	const cls = `panel panel--reasoning${collapsible && collapsed ? " panel--collapsed" : ""}${collapsible && !collapsed ? " panel--expanded" : ""}`;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click fold is a convenience shortcut, not primary interaction
		<div ref={ref} className={cls} onDoubleClick={handleDoubleClick}>
			<Markdown>{content}</Markdown>
			{status}
		</div>
	);
}
