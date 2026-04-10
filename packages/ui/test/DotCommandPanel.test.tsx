import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { ParsedDotInput } from "../src/commandParser";
import { DotCommandPanel } from "../src/DotCommandPanel";

const noopGetSessionId = () => null;

const defaultProps = {
	modelList: null,
	sessionList: null,
	subagentList: null,
	getSessionId: noopGetSessionId,
	sessionLocked: false,
};

function dot(overrides: Partial<ParsedDotInput> = {}): ParsedDotInput {
	return {
		mode: "args",
		prefix: ".",
		matches: [],
		args: "",
		command: undefined,
		...overrides,
	};
}

describe("DotCommandPanel", () => {
	test("returns null when parsed is null", () => {
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={null} />);
		expect(container.innerHTML).toBe("");
	});

	// --- Select mode ---

	test("select mode: shows command names and descriptions", () => {
		const parsed = dot({
			mode: "select",
			matches: [
				{ name: "model", description: "Switch the AI model" },
				{ name: "new", description: "Start a new chat session" },
			],
		});
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const rows = container.querySelectorAll(".slash-skill-row");
		expect(rows.length).toBe(2);
		expect(rows[0].textContent).toContain("model");
		expect(rows[0].textContent).toContain("Switch the AI model");
		expect(rows[1].textContent).toContain("new");
		expect(rows[1].textContent).toContain("Start a new chat session");
	});

	test("select mode with no matches: shows 'No matching commands'", () => {
		const parsed = dot({ mode: "select", matches: [] });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(screen.queryByText("No matching commands")).not.toBeNull();
	});

	// --- Model panel ---

	test("model panel: shows model list with index, id, cost", () => {
		const parsed = dot({ command: "model", args: "" });
		const models = [
			{ index: 1, id: "gpt-4o", cost: "$$$" },
			{ index: 2, id: "claude-sonnet", cost: "$$" },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		expect(text).toContain("1: gpt-4o ($$$)");
		expect(text).toContain("2: claude-sonnet ($$)");
	});

	test("model panel: shows 'Loading models...' when modelList is null", () => {
		const parsed = dot({ command: "model", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={null} />);
		expect(screen.queryByText("Loading models...")).not.toBeNull();
	});

	test("model panel: filters models by args", () => {
		const parsed = dot({ command: "model", args: "2" });
		const models = [
			{ index: 1, id: "gpt-4o", cost: "$$$" },
			{ index: 2, id: "claude-sonnet", cost: "$$" },
			{ index: 21, id: "gemini-pro", cost: "$" },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		// index "2" matches index 2 and 21 (startsWith)
		expect(text).not.toContain("gpt-4o");
		expect(text).toContain("claude-sonnet");
		expect(text).toContain("gemini-pro");
	});

	test("model panel: shows 'No matching models' when filter yields nothing", () => {
		const parsed = dot({ command: "model", args: "99" });
		const models = [{ index: 1, id: "gpt-4o", cost: "$$$" }];
		render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		expect(screen.queryByText("No matching models")).not.toBeNull();
	});

	// --- New panel ---

	test("new panel: shows default text when no title", () => {
		const parsed = dot({ command: "new", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(screen.queryByText("Start a new chat session (optional title)")).not.toBeNull();
	});

	test("new panel: shows title when provided", () => {
		const parsed = dot({ command: "new", args: "My Session" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(screen.queryByText("Start a new chat session: My Session")).not.toBeNull();
	});

	// --- Title panel ---

	test("title panel: shows title text", () => {
		const parsed = dot({ command: "title", args: "New Title" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(screen.queryByText("Set session title: New Title")).not.toBeNull();
	});

	test("title panel: shows 'Enter session title' when empty", () => {
		const parsed = dot({ command: "title", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(screen.queryByText("Enter session title")).not.toBeNull();
	});

	// --- Session panel ---

	test("session panel: shows sessions with index, time, title", () => {
		const parsed = dot({ command: "session", args: "" });
		const sessions = [
			{ index: 1, id: "s1", title: "First", updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 2, id: "s2", title: "Second", updatedAt: "2025-01-15T11:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const panel = container.querySelector(".panel--dot");
		expect(panel).not.toBeNull();
		const text = panel?.textContent ?? "";
		expect(text).toContain("1:");
		expect(text).toContain("First");
		expect(text).toContain("2:");
		expect(text).toContain("Second");
	});

	test("session panel: shows 'Loading sessions...' when null", () => {
		const parsed = dot({ command: "session", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={null} />);
		expect(screen.queryByText("Loading sessions...")).not.toBeNull();
	});

	test("session panel: shows 'No sessions' when empty", () => {
		const parsed = dot({ command: "session", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={[]} />);
		expect(screen.queryByText("No sessions")).not.toBeNull();
	});

	test("session panel: delete preview shows session label", () => {
		const parsed = dot({ command: "session", args: "1 delete" });
		const sessions = [{ index: 1, id: "s1", title: "My Chat", updatedAt: "2025-01-15T10:30:00Z", owned: false }];
		render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		expect(screen.queryByText(/Delete session "My Chat"/)).not.toBeNull();
	});

	// --- Subagent panel ---

	test("subagent panel: shows subagent list", () => {
		const parsed = dot({ command: "subagent", args: "" });
		const subagents = [
			{ index: 1, title: "Research task", sessionId: "sub1" },
			{ index: 2, title: "Code review", sessionId: "sub2" },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} subagentList={subagents} />);
		const text = container.textContent ?? "";
		expect(text).toContain("1: Research task");
		expect(text).toContain("2: Code review");
	});

	test("subagent panel: shows 'Loading subagents...' when null", () => {
		const parsed = dot({ command: "subagent", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} subagentList={null} />);
		expect(screen.queryByText("Loading subagents...")).not.toBeNull();
	});

	test("subagent panel: shows 'No subagent sessions' when empty", () => {
		const parsed = dot({ command: "subagent", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} subagentList={[]} />);
		expect(screen.queryByText("No subagent sessions")).not.toBeNull();
	});

	// --- View panel ---

	test("view panel: shows all 3 view modes with descriptions", () => {
		const parsed = dot({ command: "view", args: "" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("1: Chat — Grouped panels, markdown");
		expect(text).toContain("2: Context — Raw DB messages, plain text");
		expect(text).toContain("3: Compaction — Compacted view (what LLM sees)");
	});

	// --- Unrecognized command ---

	test("returns null for unrecognized command", () => {
		const parsed = dot({ command: "nonexistent", args: "" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		expect(container.innerHTML).toBe("");
	});
});
