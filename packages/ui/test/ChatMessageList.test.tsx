import { describe, expect, mock, test } from "bun:test";
import type { Message, SubagentInfo } from "../src/protocol";

// ---------------------------------------------------------------------------
// Mock Markdown — react-markdown + react-syntax-highlighter rely on DOM APIs
// that happy-dom may not fully support. Replace with a thin passthrough.
// ---------------------------------------------------------------------------
mock.module("../src/Markdown", () => ({
	Markdown: ({ children }: { children: string }) => <div className="md">{children}</div>,
}));

// ToolPanel uses useRef/useEffect for collapse detection that depends on
// getComputedStyle — simplify to a wrapper div for unit-testing ChatMessageList.
mock.module("../src/ToolPanel", () => ({
	COLLAPSE_LINES: 6,
	ToolPanel: ({ children }: { children: React.ReactNode }) => <div className="panel panel--tool">{children}</div>,
}));

// Import AFTER mocks are registered
const { render } = await import("@testing-library/react");
const { ChatMessageList } = await import("../src/ChatMessageList");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps = {
	subagents: [] as SubagentInfo[],
	isStreaming: false,
	viewingSubagentId: null,
	parentId: null,
	peekSubagentWithScroll: () => {},
	peekSubagentFromDbWithScroll: () => {},
};

function mkUserMsg(text: string, timestamp = "12:00:00"): Message {
	return { role: "user", text, timestamp };
}

function mkAssistantMsg(
	parts: Message extends { role: "assistant"; parts: infer P } ? P : never,
	opts: { timestamp?: string; model?: string; summary?: string } = {},
): Message {
	return { role: "assistant", parts, ...opts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ChatMessageList", () => {
	test("empty messages list renders nothing", () => {
		const { container } = render(<ChatMessageList messages={[]} {...defaultProps} />);
		expect(container.innerHTML).toBe("");
	});

	test("user message renders with text and timestamp", () => {
		const { container } = render(<ChatMessageList messages={[mkUserMsg("Hello!", "14:30:00")]} {...defaultProps} />);
		const panel = container.querySelector(".panel--user");
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("Hello!");
		expect(panel?.textContent).toContain("14:30:00");
	});

	test("user message in subagent view renders with Markdown", () => {
		const { container } = render(
			<ChatMessageList messages={[mkUserMsg("**bold text**", "15:00:00")]} {...defaultProps} viewingSubagentId="sub-1" />,
		);
		const panel = container.querySelector(".panel--user");
		expect(panel).not.toBeNull();
		// In subagent view, content should be wrapped in .md (our mocked Markdown)
		const md = panel?.querySelector(".md");
		expect(md).not.toBeNull();
		expect(md?.textContent).toContain("**bold text**");
	});

	test("assistant message with text part renders panel with content", () => {
		const msg = mkAssistantMsg([{ type: "text", content: "Here is the answer." }]);
		const { container } = render(<ChatMessageList messages={[msg]} {...defaultProps} />);
		const panel = container.querySelector(".panel--assistant");
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("Here is the answer.");
	});

	test("assistant message with tool_call part renders ToolPanel", () => {
		const msg = mkAssistantMsg([{ type: "tool_call", id: "tc_1", content: "Running bash..." }]);
		const { container } = render(<ChatMessageList messages={[msg]} {...defaultProps} />);
		const toolPanel = container.querySelector(".panel--tool");
		expect(toolPanel).not.toBeNull();
		expect(toolPanel?.textContent).toContain("Running bash...");
	});

	test("assistant message with timestamp shows timestamp in panel-status", () => {
		const msg = mkAssistantMsg([{ type: "text", content: "Done." }], { timestamp: "16:45:00", model: "gpt-4" });
		const { container } = render(<ChatMessageList messages={[msg]} {...defaultProps} />);
		const status = container.querySelector(".panel-status");
		expect(status).not.toBeNull();
		expect(status?.textContent).toContain("16:45:00");
	});

	test("multiple messages render in order", () => {
		const messages: Message[] = [
			mkUserMsg("First", "10:00:00"),
			mkAssistantMsg([{ type: "text", content: "Second" }]),
			mkUserMsg("Third", "10:01:00"),
		];
		const { container } = render(<ChatMessageList messages={messages} {...defaultProps} />);
		const panels = container.querySelectorAll(".panel--user, .panel--assistant");
		expect(panels).toHaveLength(3);
		expect(panels[0]?.textContent).toContain("First");
		expect(panels[1]?.textContent).toContain("Second");
		expect(panels[2]?.textContent).toContain("Third");
	});
});
