import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { ParsedDotInput } from "../src/commandParser";
import { DotCommandPanel } from "../src/DotCommandPanel";

const noopGetSessionId = () => null;

const defaultProps = {
	modelList: null,
	providerList: null,
	sessionList: null,
	subagentList: null,
	getSessionId: noopGetSessionId,
	sessionLocked: false,
};

function makeModel(index: number, id: string, cost: string, contextWindow = 0) {
	return { index, id, cost, contextWindow };
}

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

	test("model panel: shows model list with index, id, cost, and context when available", () => {
		const parsed = dot({ command: "model", args: "" });
		const models = [makeModel(1, "gpt-4o", "0x", 128000), makeModel(2, "claude-sonnet", "1x", 200000)];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		expect(text).toContain("1: gpt-4o (0x, 128k)");
		expect(text).toContain("2: claude-sonnet (1x, 200k)");
	});

	test("model panel: shows 'Loading models...' when modelList is null", () => {
		const parsed = dot({ command: "model", args: "" });
		render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={null} />);
		expect(screen.queryByText("Loading models...")).not.toBeNull();
	});

	test("model panel: numeric args still filter by index contains semantics", () => {
		const parsed = dot({ command: "model", args: "2" });
		const models = [
			makeModel(1, "gpt-4o", "0x", 128000),
			makeModel(2, "claude-sonnet", "1x", 200000),
			makeModel(21, "gemini-pro", "1x", 256000),
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		expect(text).not.toContain("gpt-4o");
		expect(text).toContain("claude-sonnet");
		expect(text).toContain("gemini-pro");
	});

	test("model panel: text args use fuzzy search on id", () => {
		const parsed = dot({ command: "model", args: "g54" });
		const models = [
			makeModel(1, "claude-sonnet-4.6", "1x", 200000),
			makeModel(2, "gpt-5.4", "1x", 256000),
			makeModel(3, "gemini-3-flash", "0.33x", 1000000),
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		expect(text).toContain("gpt-5.4");
		expect(text).not.toContain("claude-sonnet-4.6");
	});

	test("model panel: falls back to cost-only formatting when context is missing", () => {
		const parsed = dot({ command: "model", args: "" });
		const models = [makeModel(3, "some-model", "1x", 0)];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		expect(container.textContent ?? "").toContain("3: some-model (1x)");
	});

	test("model panel: shows 'No matching models' when filter yields nothing", () => {
		const parsed = dot({ command: "model", args: "zzz" });
		const models = [makeModel(1, "gpt-4o", "0x", 128000)];
		render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		expect(screen.queryByText("No matching models")).not.toBeNull();
	});

	test("model panel: rows are shown in server-provided order", () => {
		const parsed = dot({ command: "model", args: "" });
		const models = [makeModel(1, "b-model", "1x", 100000), makeModel(2, "a-model", "1x", 200000)];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const rows = Array.from(container.querySelectorAll(".dot-scroll > div")).map((row) => row.textContent ?? "");
		expect(rows[0]).toContain("b-model");
		expect(rows[1]).toContain("a-model");
	});

	test("model panel: left-pads indices when the list has 10+ items", () => {
		const parsed = dot({ command: "model", args: "" });
		const models = Array.from({ length: 10 }, (_, i) => makeModel(i + 1, `model-${i + 1}`, "1x", 100000));
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const text = container.textContent ?? "";
		expect(text).toContain(" 1: model-1 (1x, 100k)");
		expect(text).toContain("10: model-10 (1x, 100k)");
	});

	test("model panel: text results show all matching rows", () => {
		const parsed = dot({ command: "model", args: "mod" });
		const models = Array.from({ length: 25 }, (_, i) => makeModel(i + 1, `model-${i + 1}`, "1x", 100000));
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} modelList={models} />);
		const rows = container.querySelectorAll(".dot-scroll > div");
		expect(rows.length).toBe(25);
		expect(container.textContent ?? "").toContain("model-25");
	});

	test("provider panel lists authenticated providers with runtime support note", () => {
		const parsed = dot({ command: "provider", args: "" });
		const providers = [
			{ index: 1, id: "github-copilot", runtimeSupported: true },
			{ index: 2, id: "openrouter", runtimeSupported: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} providerList={providers} />);
		const text = container.textContent ?? "";
		expect(text).toContain("1: github-copilot");
		expect(text).toContain("2: openrouter (runtime not supported yet)");
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

	test("session panel: text mode uses fuzzy title search, not plain word containment", () => {
		const parsed = dot({ command: "session", args: "g54" });
		const sessions = [
			{ index: 1, id: "s1", title: "GPT 5.4 migration", updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 2, id: "s2", title: "fix UI issues", updatedAt: "2025-01-15T11:00:00Z", owned: false },
			{ index: 3, id: "s3", title: "some other tests", updatedAt: "2025-01-15T12:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const text = container.textContent ?? "";
		expect(text).toContain("GPT 5.4 migration");
		expect(text).not.toContain("fix UI issues");
		expect(text).not.toContain("some other tests");
	});

	test("session panel: title search is case-insensitive", () => {
		const parsed = dot({ command: "session", args: "IMPL" });
		const sessions = [
			{ index: 1, id: "s1", title: "Implement Feature", updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 2, id: "s2", title: "fix bugs", updatedAt: "2025-01-15T11:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const text = container.textContent ?? "";
		expect(text).toContain("Implement Feature");
		expect(text).not.toContain("fix bugs");
	});

	test("session panel: title search with no matches shows message", () => {
		const parsed = dot({ command: "session", args: "nonexistent" });
		const sessions = [{ index: 1, id: "s1", title: "implement tests", updatedAt: "2025-01-15T10:30:00Z", owned: false }];
		render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		expect(screen.queryByText("No matching sessions")).not.toBeNull();
	});

	test("session panel: sessions with null title are excluded from title search", () => {
		const parsed = dot({ command: "session", args: "test" });
		const sessions = [
			{ index: 1, id: "s1", title: null, updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 2, id: "s2", title: "run tests", updatedAt: "2025-01-15T11:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const text = container.textContent ?? "";
		expect(text).toContain("run tests");
		// Session 1 has null title, should not appear
		const lines = container.querySelectorAll(".dot-scroll > div");
		const lineTexts = Array.from(lines).map((l) => l.textContent ?? "");
		expect(lineTexts.every((t) => !t.startsWith("1:"))).toBe(true);
	});

	test("session panel: numeric arg still filters by index, not title", () => {
		const parsed = dot({ command: "session", args: "2" });
		const sessions = [
			{ index: 1, id: "s1", title: "Session One", updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 2, id: "s2", title: "Session Two", updatedAt: "2025-01-15T11:00:00Z", owned: false },
			{ index: 12, id: "s12", title: "Session Twelve", updatedAt: "2025-01-15T12:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const text = container.textContent ?? "";
		expect(text).toContain("Session Two");
		expect(text).toContain("Session Twelve");
		expect(text).not.toContain("Session One");
	});

	test("session panel: arg starting with digit but containing letters uses text search", () => {
		const parsed = dot({ command: "session", args: "2test" });
		const sessions = [
			{ index: 2, id: "s2", title: "Session Two", updatedAt: "2025-01-15T10:30:00Z", owned: false },
			{ index: 3, id: "s3", title: "2test session", updatedAt: "2025-01-15T11:00:00Z", owned: false },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const text = container.textContent ?? "";
		expect(text).toContain("2test session");
		expect(text).not.toContain("Session Two");
	});

	test("session panel: text results preserve original order for equal scores and show all rows", () => {
		const parsed = dot({ command: "session", args: "task" });
		const sessions = Array.from({ length: 25 }, (_, i) => ({
			index: i + 1,
			id: `s${i + 1}`,
			title: `Task ${i + 1}`,
			updatedAt: "2025-01-15T10:30:00Z",
			owned: false,
		}));
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} sessionList={sessions} />);
		const rows = Array.from(container.querySelectorAll(".dot-scroll > div")).map((row) => row.textContent ?? "");
		expect(rows).toHaveLength(25);
		expect(rows[0]).toContain("Task 1");
		expect(rows[24]).toContain("Task 25");
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

	test("subagent panel: text input filters by title using fuzzy ranking", () => {
		const parsed = dot({ command: "subagent", args: "cr" });
		const subagents = [
			{ index: 1, title: "Research task", sessionId: "sub1" },
			{ index: 2, title: "Code review", sessionId: "sub2" },
			{ index: 3, title: "Follow up", sessionId: "sub3" },
		];
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} subagentList={subagents} />);
		const text = container.textContent ?? "";
		expect(text).toContain("Code review");
		expect(text).not.toContain("Research task");
		expect(text).not.toContain("Follow up");
	});

	test("subagent panel: text results preserve original order for equal scores and show all rows", () => {
		const parsed = dot({ command: "subagent", args: "task" });
		const subagents = Array.from({ length: 25 }, (_, i) => ({
			index: i + 1,
			title: `Task ${i + 1}`,
			sessionId: `sub${i + 1}`,
		}));
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} subagentList={subagents} />);
		const rows = Array.from(container.querySelectorAll(".dot-scroll > div")).map((row) => row.textContent ?? "");
		expect(rows).toHaveLength(25);
		expect(rows[0]).toContain("Task 1");
		expect(rows[24]).toContain("Task 25");
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

	// --- Configuration panel ---

	test("configuration panel: shows scopes when no args", () => {
		const parsed = dot({ command: "configuration", args: "" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("project");
		expect(text).toContain("global");
	});

	test("configuration panel: with unambiguous scope shows fields only after space", () => {
		// No trailing space — still filtering scopes
		const parsed = dot({ command: "configuration", args: "project" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("project");
		expect(text).not.toContain("debug");
	});

	test("configuration panel: with scope and trailing space shows fields", () => {
		const parsed = dot({ command: "configuration", args: "project " });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("debug");
		expect(text).toContain("maxIterations");
	});

	test("configuration panel: abbreviated scope without space shows filtered scopes", () => {
		const parsed = dot({ command: "configuration", args: "g" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("global");
		expect(text).not.toContain("project");
		expect(text).not.toContain("debug");
	});

	test("configuration panel: abbreviated scope with trailing space shows fields", () => {
		const parsed = dot({ command: "configuration", args: "g " });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("debug");
		expect(text).toContain("maxIterations");
	});

	test("configuration panel: with scope and unambiguous field debug shows field hint, not values", () => {
		const parsed = dot({ command: "configuration", args: "project debug" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("debug");
		expect(text).toContain("true | false");
		// Should not jump to value hints without trailing space
		expect(text).not.toContain("Enable debug mode");
	});

	test("configuration panel: with scope and unambiguous field port shows field hint, not value hint", () => {
		const parsed = dot({ command: "configuration", args: "project port" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("port");
		expect(text).toContain("Enter a port number");
	});

	test("configuration panel: with scope and ambiguous field prefix shows only matching fields", () => {
		// "p" matches both "provider" and "port" — only those should show
		const parsed = dot({ command: "configuration", args: "project p" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("provider");
		expect(text).toContain("port");
		expect(text).not.toContain("debug");
	});

	test("configuration panel: with ambiguous scope prefix shows no match", () => {
		const parsed = dot({ command: "configuration", args: "x" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("No matching options");
	});

	test("configuration panel: value filter 't' for debug shows only true", () => {
		const parsed = dot({ command: "configuration", args: "global debug t" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("true");
		expect(text).not.toContain("false");
	});

	test("configuration panel: value filter 'f' for debug shows only false", () => {
		const parsed = dot({ command: "configuration", args: "global debug f" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("false");
		expect(text).not.toContain("true");
	});

	test("configuration panel: non-matching value filter shows 'No matching options'", () => {
		const parsed = dot({ command: "configuration", args: "global debug z" });
		const { container } = render(<DotCommandPanel {...defaultProps} parsed={parsed} />);
		const text = container.textContent ?? "";
		expect(text).toContain("No matching options");
	});
});
