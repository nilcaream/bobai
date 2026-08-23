import { describe, expect, mock, test } from "bun:test";

// Markdown relies on react-markdown + react-syntax-highlighter, which need DOM
// APIs happy-dom may not fully support — replace with a thin passthrough.
mock.module("../src/Markdown", () => ({
	Markdown: ({ children }: { children: string }) => <div className="md">{children}</div>,
}));

// Import AFTER mocks are registered
const { fireEvent, render } = await import("@testing-library/react");
const { ReasoningPanel } = await import("../src/ReasoningPanel");

// Simulate an overflowing panel: happy-dom doesn't lay out, so scrollHeight and
// clientHeight are both 0 by default. Shadow them on the .md instance so the
// overflow check (scrollHeight > clientHeight) sees content taller than the cap.
function stubOverflow(container: HTMLElement) {
	const md = container.querySelector(".md") as HTMLElement;
	Object.defineProperty(md, "scrollHeight", { value: 200, configurable: true });
	Object.defineProperty(md, "clientHeight", { value: 150, configurable: true });
	return md;
}

describe("ReasoningPanel", () => {
	test("renders reasoning content inside a .md child of the panel", () => {
		const { container } = render(<ReasoningPanel content="Let me think..." />);
		const panel = container.querySelector(".panel--reasoning");
		expect(panel).not.toBeNull();
		const md = panel?.querySelector(".md");
		expect(md).not.toBeNull();
		expect(md?.textContent).toBe("Let me think...");
	});

	test("renders the status node below the clipped content", () => {
		const { container } = render(<ReasoningPanel content="Reasoning" status={<div className="panel-status">14:00:00</div>} />);
		const panel = container.querySelector(".panel--reasoning");
		expect(panel).not.toBeNull();
		// Content (.md) must come before status in DOM order, so the status
		// line stays visible below the clipped 10-line box.
		expect(panel?.children[0]?.className).toContain("md");
		expect(panel?.children[1]?.className).toBe("panel-status");
		expect(panel?.children[1]?.textContent).toBe("14:00:00");
	});

	test("renders no status node when omitted", () => {
		const { container } = render(<ReasoningPanel content="Reasoning" />);
		expect(container.querySelector(".panel-status")).toBeNull();
	});

	test("short content is not collapsible and has no collapse/expand class", () => {
		const { container } = render(<ReasoningPanel content="short" />);
		const panel = container.querySelector(".panel--reasoning");
		expect(panel?.className).toBe("panel panel--reasoning");
	});

	test("overflowing content is collapsed by default and double-click expands", () => {
		const { container, rerender } = render(<ReasoningPanel content="short" />);
		stubOverflow(container);
		// Re-render with appended content so the effect re-measures against the
		// stubbed dimensions (scrollHeight 200 > clientHeight 150).
		rerender(<ReasoningPanel content="short and now much longer" />);

		const panel = container.querySelector(".panel--reasoning") as HTMLElement;
		expect(panel.className).toContain("panel--collapsed");

		fireEvent.dblClick(panel);
		expect(panel.className).toContain("panel--expanded");
		expect(panel.className).not.toContain("panel--collapsed");

		fireEvent.dblClick(panel);
		expect(panel.className).toContain("panel--collapsed");
		expect(panel.className).not.toContain("panel--expanded");
	});

	test("double-click on a non-collapsible panel does nothing", () => {
		const { container } = render(<ReasoningPanel content="short" />);
		const panel = container.querySelector(".panel--reasoning") as HTMLElement;
		fireEvent.dblClick(panel);
		expect(panel.className).toBe("panel panel--reasoning");
	});
});
