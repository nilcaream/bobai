import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	handleGenericCommand,
	handleNewCommand,
	handleSessionCommand,
	handleSessionShortcut,
	handleSlashCommand,
	handleStopCommand,
	handleSubagentCommand,
	handleViewCommand,
} from "../src/commandHandlers";
import type { ViewMode } from "../src/commandParser";

function makeModel(index: number, id: string, cost: string, contextWindow = 0) {
	return { index, id, cost, contextWindow };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the updater function passed to a mock's first call. */
function extractUpdater<T>(fn: (...args: T[]) => unknown): T {
	return fn.mock.calls[0][0];
}

type ViewState = { mode: string; lineLimit: number };
type ViewUpdater = (prev: ViewState) => ViewState;
type SkillEntry = { name: string; content: string };
type SkillUpdater = (prev: SkillEntry[]) => SkillEntry[];

/** Create a Response that resolves to the given JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Flush microtask queue so fetch .then() chains resolve. */
async function flushPromises(): Promise<void> {
	// Two rounds to cover chained .then()
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Reset global fetch before each test
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
	fetchMock = mock(() => Promise.resolve(jsonResponse({})));
	globalThis.fetch = fetchMock;
});

// ===========================================================================
// 1. handleStopCommand
// ===========================================================================

describe("handleStopCommand", () => {
	test("calls sendCancel", () => {
		const sendCancel = mock(() => {});
		handleStopCommand({ sendCancel });
		expect(sendCancel).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// 2. handleNewCommand
// ===========================================================================

describe("handleNewCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleNewCommand>[0]> = {}) {
		return {
			newChat: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setStatus: mock(() => {}),
			defaultStatus: "idle",
			setView: mock(() => {}),
			setTitle: mock(() => {}),
			pendingNewTitle: { current: null } as { current: string | null },
			setWelcomeMarkdown: mock(() => {}),
			newTitle: "",
			...overrides,
		};
	}

	test("calls newChat, clears staged skills, resets status, sets view to chat", () => {
		const params = makeParams();
		handleNewCommand(params);

		expect(params.newChat).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setStatus).toHaveBeenCalledWith("idle");
		// setView is called with an updater function
		expect(params.setView).toHaveBeenCalledTimes(1);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		const result = updater({ mode: "context", lineLimit: 48 });
		expect(result).toEqual({ mode: "chat", lineLimit: 48 });
	});

	test("when newTitle is non-empty, sets title and pendingNewTitle", () => {
		const params = makeParams({ newTitle: "My Session" });
		handleNewCommand(params);

		expect(params.setTitle).toHaveBeenCalledWith("My Session");
		expect(params.pendingNewTitle.current).toBe("My Session");
	});

	test("when newTitle is empty, does NOT call setTitle", () => {
		const params = makeParams({ newTitle: "" });
		handleNewCommand(params);

		expect(params.setTitle).not.toHaveBeenCalled();
		expect(params.pendingNewTitle.current).toBeNull();
	});

	test("fetches /bobai/welcome and calls setWelcomeMarkdown on success", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ markdown: "# Welcome" })));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();

		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/welcome");
		expect(params.setWelcomeMarkdown).toHaveBeenCalledWith("# Welcome");
	});

	test("does not call setWelcomeMarkdown when markdown is empty", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ markdown: "" })));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();

		expect(params.setWelcomeMarkdown).not.toHaveBeenCalled();
	});

	test("silently ignores fetch failure for /bobai/welcome", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();

		expect(params.setWelcomeMarkdown).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 3. handleViewCommand
// ===========================================================================

describe("handleViewCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleViewCommand>[0]> = {}) {
		return {
			arg: "",
			setView: mock(() => {}),
			fetchContext: mock(() => {}),
			fetchCompactedContext: mock(() => {}),
			scrollToBottom: mock(() => {}),
			...overrides,
		};
	}

	function callAndGetMode(params: ReturnType<typeof makeParams>, prevMode: ViewMode): ViewMode {
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		const result = updater({ mode: prevMode, lineLimit: 48 });
		return result.mode;
	}

	test('arg="1" sets view to chat', () => {
		const params = makeParams({ arg: "1" });
		const mode = callAndGetMode(params, "context");
		expect(mode).toBe("chat");
		expect(params.fetchContext).not.toHaveBeenCalled();
		expect(params.fetchCompactedContext).not.toHaveBeenCalled();
	});

	test('arg="2" sets view to context and calls fetchContext', () => {
		const params = makeParams({ arg: "2" });
		const mode = callAndGetMode(params, "chat");
		expect(mode).toBe("context");
		expect(params.fetchContext).toHaveBeenCalledTimes(1);
		expect(params.fetchCompactedContext).not.toHaveBeenCalled();
	});

	test('arg="3" sets view to compaction and calls fetchCompactedContext', () => {
		const params = makeParams({ arg: "3" });
		const mode = callAndGetMode(params, "chat");
		expect(mode).toBe("compaction");
		expect(params.fetchCompactedContext).toHaveBeenCalledTimes(1);
		expect(params.fetchContext).not.toHaveBeenCalled();
	});

	test("empty arg cycles from chat to context", () => {
		const params = makeParams({ arg: "" });
		const mode = callAndGetMode(params, "chat");
		expect(mode).toBe("context");
		expect(params.fetchContext).toHaveBeenCalledTimes(1);
	});

	test("empty arg cycles from context to compaction", () => {
		const params = makeParams({ arg: "" });
		const mode = callAndGetMode(params, "context");
		expect(mode).toBe("compaction");
		expect(params.fetchCompactedContext).toHaveBeenCalledTimes(1);
	});

	test("empty arg cycles from compaction to chat", () => {
		const params = makeParams({ arg: "" });
		const mode = callAndGetMode(params, "compaction");
		expect(mode).toBe("chat");
	});

	test("invalid arg keeps current mode", () => {
		const params = makeParams({ arg: "9" });
		const mode = callAndGetMode(params, "context");
		expect(mode).toBe("context");
		// context → context still triggers fetchContext because next === "context"
		expect(params.fetchContext).toHaveBeenCalledTimes(1);
	});

	test("lineLimit is preserved through mode changes", () => {
		const params = makeParams({ arg: "2" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		const result = updater({ mode: "chat", lineLimit: 100 });
		expect(result.lineLimit).toBe(100);
	});

	test("scrolls to bottom after switching view via requestAnimationFrame", async () => {
		const params = makeParams({ arg: "1" });
		handleViewCommand(params);
		// scrollToBottom is called inside requestAnimationFrame, so flush it
		await new Promise((r) => setTimeout(r, 0));
		expect(params.scrollToBottom).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// 4. handleSessionCommand
// ===========================================================================

describe("handleSessionCommand", () => {
	const sessionList = [
		{ index: 1, id: "aaa", title: "Session A", updatedAt: "2024-01-01", owned: false },
		{ index: 2, id: "bbb", title: "Session B", updatedAt: "2024-01-02", owned: true },
		{ index: 3, id: "ccc", title: null, updatedAt: "2024-01-03", owned: false },
	];

	function makeParams(overrides: Partial<Parameters<typeof handleSessionCommand>[0]> = {}) {
		return {
			arg: "",
			sessionList: sessionList as typeof sessionList | null,
			getSessionId: mock(() => "current-id"),
			loadSession: mock(() => {}),
			newChat: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setStatus: mock(() => {}),
			defaultStatus: "idle",
			setView: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("empty arg is a no-op", () => {
		const params = makeParams({ arg: "" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).not.toHaveBeenCalled();
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("null sessionList sets volatile error", () => {
		const params = makeParams({ arg: "1", sessionList: null });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session list not loaded", "error");
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({ arg: "99" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid session index: 99", "error");
	});

	test("non-numeric arg triggers text search (no longer treated as invalid index)", () => {
		const params = makeParams({ arg: "xyz" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No session matching "xyz"', "error");
	});

	// -- Delete subcommand --

	test("delete session owned by another tab sets error", () => {
		// Session 2 (bbb) is owned=true, and current session is "current-id" (not bbb)
		const params = makeParams({ arg: "2 delete" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Cannot delete: session is active in another tab", "error");
	});

	test("delete current session clears state then fetches DELETE", async () => {
		// Make session 1 the current session
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true, id: "aaa", title: "Session A" })));
		const params = makeParams({
			arg: "1 delete",
			getSessionId: mock(() => "aaa"),
		});

		handleSessionCommand(params);

		// Should clear state first
		expect(params.newChat).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setStatus).toHaveBeenCalledWith("idle");
		expect(params.setView).toHaveBeenCalledTimes(1);

		// Should fetch DELETE
		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/session/aaa", { method: "DELETE" });

		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith('Session aaa "Session A" has been removed', "success");
	});

	test("delete non-self non-owned session fetches DELETE without clearing state", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true, id: "aaa", title: null })));
		const params = makeParams({ arg: "1 delete" });

		handleSessionCommand(params);

		// Should NOT clear state (not self)
		expect(params.newChat).not.toHaveBeenCalled();

		// Should fetch DELETE
		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/session/aaa", { method: "DELETE" });

		await flushPromises();
		// No title → just id
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session aaa has been removed", "success");
	});

	test("delete with ok:false sets error from response", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false, error: "DB error" })));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("DB error", "error");
	});

	test("delete with ok:false and no error field uses fallback message", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to delete session", "error");
	});

	test("delete fetch failure sets volatile error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to delete session", "error");
	});

	// -- Session switching --

	test("switching to self is a no-op", () => {
		const params = makeParams({
			arg: "1",
			getSessionId: mock(() => "aaa"),
		});
		handleSessionCommand(params);
		expect(params.loadSession).not.toHaveBeenCalled();
		expect(params.addVolatileMessage).not.toHaveBeenCalled();
	});

	test("switching to owned-by-other session sets error", () => {
		const params = makeParams({ arg: "2" }); // bbb, owned=true
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session is active in another tab", "error");
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("switching to available session calls loadSession, clears staged skills, and resets view", () => {
		const params = makeParams({ arg: "1" }); // aaa, not owned, not self
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("aaa");
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setView).toHaveBeenCalledTimes(1);
	});

	test("switching to session with null title works", () => {
		const params = makeParams({ arg: "3" }); // ccc, not owned, title=null
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("ccc");
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setView).toHaveBeenCalledTimes(1);
	});

	// -- Unknown subcommand --

	test("unknown subcommand sets volatile error", () => {
		const params = makeParams({ arg: "1 fix" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Unknown subcommand: fix", "error");
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	// -- Text search --

	test("text search: loads first fuzzy-visible session", () => {
		const params = makeParams({
			arg: "g54",
			sessionList: [
				{ index: 1, id: "s1", title: "GPT 5.4 migration", updatedAt: "2024-01-01", owned: false },
				{ index: 2, id: "s2", title: "fix UI issues", updatedAt: "2024-01-02", owned: false },
				{ index: 3, id: "s3", title: "some other tests", updatedAt: "2024-01-03", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("text search: case-insensitive matching", () => {
		const params = makeParams({
			arg: "IMPL",
			sessionList: [
				{ index: 1, id: "s1", title: "Implement Feature", updatedAt: "2024-01-01", owned: false },
				{ index: 2, id: "s2", title: "fix bugs", updatedAt: "2024-01-02", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("text search: no match sets volatile error", () => {
		const params = makeParams({
			arg: "nonexistent",
			sessionList: [{ index: 1, id: "s1", title: "implement tests", updatedAt: "2024-01-01", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No session matching "nonexistent"', "error");
	});

	test("text search: first visible match is self — silently no-op", () => {
		const params = makeParams({
			arg: "ta",
			sessionList: [
				{ index: 1, id: "current-id", title: "Task alpha", updatedAt: "2024-01-01", owned: false },
				{ index: 2, id: "s2", title: "Task beta", updatedAt: "2024-01-02", owned: false },
			],
			getSessionId: mock(() => "current-id"),
		});
		handleSessionCommand(params);
		expect(params.loadSession).not.toHaveBeenCalled();
		expect(params.addVolatileMessage).not.toHaveBeenCalled();
	});

	test("text search: first visible match owned by another tab — shows error", () => {
		const params = makeParams({
			arg: "ta",
			sessionList: [
				{ index: 1, id: "s1", title: "Task alpha", updatedAt: "2024-01-01", owned: true },
				{ index: 2, id: "s2", title: "Task beta", updatedAt: "2024-01-02", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session is active in another tab", "error");
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("text search: arg starting with digit but containing letters uses text search", () => {
		const params = makeParams({
			arg: "2test",
			sessionList: [
				{ index: 2, id: "s2", title: "Session Two", updatedAt: "2024-01-01", owned: false },
				{ index: 3, id: "s3", title: "2test session", updatedAt: "2024-01-02", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s3");
	});

	test("text search: sessions with null title are excluded", () => {
		const params = makeParams({
			arg: "test",
			sessionList: [{ index: 1, id: "s1", title: null, updatedAt: "2024-01-01", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No session matching "test"', "error");
	});
});

// ===========================================================================
// 5. handleSubagentCommand
// ===========================================================================

describe("handleSubagentCommand", () => {
	const subagentList = [
		{ index: 1, title: "Sub A", sessionId: "sub-aaa" },
		{ index: 2, title: "Sub B", sessionId: "sub-bbb" },
	];

	const subagents = [
		{ sessionId: "sub-aaa", title: "Sub A", status: "running" as const, toolCallId: "tc1" },
		{ sessionId: "sub-bbb", title: "Sub B", status: "done" as const, toolCallId: "tc2" },
	];

	function makeParams(overrides: Partial<Parameters<typeof handleSubagentCommand>[0]> = {}) {
		return {
			arg: "",
			subagentList: subagentList as typeof subagentList | null,
			subagents,
			peekSubagentWithScroll: mock(() => {}),
			peekSubagentFromDbWithScroll: mock(() => {}),
			setStagedSkills: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("empty arg is a no-op", () => {
		const params = makeParams({ arg: "" });
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).not.toHaveBeenCalled();
		expect(params.peekSubagentFromDbWithScroll).not.toHaveBeenCalled();
		expect(params.addVolatileMessage).not.toHaveBeenCalled();
	});

	test("null subagentList sets volatile error", () => {
		const params = makeParams({ arg: "1", subagentList: null });
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Subagent list not loaded", "error");
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({ arg: "99" });
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid subagent index: 99", "error");
	});

	test("text search with no match sets volatile error", () => {
		const params = makeParams({ arg: "foo" });
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No subagent matching "foo"', "error");
	});

	test("numeric index with live (running) subagent calls peekSubagentWithScroll", () => {
		const params = makeParams({ arg: "1" }); // sub-aaa is running
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).toHaveBeenCalledWith("sub-aaa");
		expect(params.peekSubagentFromDbWithScroll).not.toHaveBeenCalled();
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});

	test("numeric index with non-live subagent calls peekSubagentFromDbWithScroll", () => {
		const params = makeParams({ arg: "2" }); // sub-bbb is done
		handleSubagentCommand(params);
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledWith("sub-bbb");
		expect(params.peekSubagentWithScroll).not.toHaveBeenCalled();
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});

	test("text search: first fuzzy-visible live subagent uses live peek", () => {
		const params = makeParams({
			arg: "sa",
			subagentList: [
				{ index: 1, title: "Sub A", sessionId: "sub-aaa" },
				{ index: 2, title: "Sub B", sessionId: "sub-bbb" },
			],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).toHaveBeenCalledWith("sub-aaa");
		expect(params.peekSubagentFromDbWithScroll).not.toHaveBeenCalled();
	});

	test("text search: first fuzzy-visible completed subagent uses db peek", () => {
		const params = makeParams({
			arg: "br",
			subagentList: [
				{ index: 1, title: "Sub A", sessionId: "sub-aaa" },
				{ index: 2, title: "Bug review", sessionId: "sub-bbb" },
			],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledWith("sub-bbb");
		expect(params.peekSubagentWithScroll).not.toHaveBeenCalled();
	});

	test("clears staged skills on success regardless of live/db path", () => {
		const params1 = makeParams({ arg: "1" });
		handleSubagentCommand(params1);
		expect(params1.setStagedSkills).toHaveBeenCalledWith([]);

		const params2 = makeParams({ arg: "2" });
		handleSubagentCommand(params2);
		expect(params2.setStagedSkills).toHaveBeenCalledWith([]);
	});
});

// ===========================================================================
// 6. handleGenericCommand
// ===========================================================================

describe("handleGenericCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleGenericCommand>[0]> = {}) {
		return {
			command: "test",
			args: "arg1",
			getSessionId: mock(() => "sid-123"),
			setSessionId: mock(() => {}),
			setModel: mock(() => {}),
			setTitle: mock(() => {}),
			setStatus: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			modelList: null as { index: number; id: string; cost: string; contextWindow: number }[] | null,
			...overrides,
		};
	}

	test("sends POST to /bobai/command with correct body", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams({ command: "model", args: "3" });
		handleGenericCommand(params);

		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "3", sessionId: "sid-123" }),
		});
	});

	test("model text submit posts the resolved numeric index, not the raw query", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [makeModel(1, "claude-3", "$0.02", 200000), makeModel(2, "gpt-5.4", "$0.01", 256000)];
		const params = makeParams({ command: "model", args: "g54", modelList });
		handleGenericCommand(params);

		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "2", sessionId: "sid-123" }),
		});
	});

	test("on success with sessionId, calls setSessionId", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true, sessionId: "new-sid" })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setSessionId).toHaveBeenCalledWith("new-sid");
	});

	test("on success without sessionId, does not call setSessionId", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setSessionId).not.toHaveBeenCalled();
	});

	test('on success with command "model", finds numeric model index in list and calls setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [makeModel(1, "gpt-4", "$0.01", 128000), makeModel(2, "claude-3", "$0.02", 200000)];
		const params = makeParams({ command: "model", args: "2", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).toHaveBeenCalledWith("claude-3");
	});

	test('on success with command "model" and text args, resolves first fuzzy-visible model and calls setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [makeModel(1, "claude-3", "$0.02", 200000), makeModel(2, "gpt-5.4", "$0.01", 256000)];
		const params = makeParams({ command: "model", args: "g54", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).toHaveBeenCalledWith("gpt-5.4");
	});

	test('on success with command "model" but no matching numeric or fuzzy result, does not call setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [makeModel(1, "gpt-4", "$0.01", 128000)];
		const params = makeParams({ command: "model", args: "zzz", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).not.toHaveBeenCalled();
	});

	test("model text submit with no match does not post raw text and shows existing error behavior", () => {
		const params = makeParams({
			command: "model",
			args: "zzz",
			modelList: [makeModel(1, "gpt-4", "$0.01", 128000)],
		});
		handleGenericCommand(params);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No model matching "zzz"', "error");
	});

	test("model numeric submit with invalid index still posts to server for server-style invalid-index error", () => {
		const params = makeParams({
			command: "model",
			args: "999",
			modelList: [makeModel(1, "gpt-4", "$0.01", 128000)],
		});
		handleGenericCommand(params);
		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "model", args: "999", sessionId: "sid-123" }),
		});
		expect(params.addVolatileMessage).not.toHaveBeenCalled();
	});

	test('on success with command "model" but null modelList, does not call setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams({ command: "model", args: "1", modelList: null });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).not.toHaveBeenCalled();
	});

	test('on success with command "title", calls setTitle with args', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams({ command: "title", args: "New Title" });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setTitle).toHaveBeenCalledWith("New Title");
	});

	test("on success with status, calls setStatus", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true, status: "busy" })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setStatus).toHaveBeenCalledWith("busy");
	});

	test("on success without status, does not call setStatus", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setStatus).not.toHaveBeenCalled();
	});

	test("on failure (ok: false) with error, sets volatile error", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false, error: "Bad command" })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("Bad command", "error");
	});

	test("on failure (ok: false) without error field, uses fallback", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("Command failed", "error");
	});

	test("on fetch error, sets volatile error with generic message", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});

	test("includes null sessionId when getSessionId returns null", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams({ getSessionId: mock(() => null) });
		handleGenericCommand(params);

		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "test", args: "arg1", sessionId: null }),
		});
	});

	test("multiple result fields are all processed (sessionId + status + model)", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true, sessionId: "new-sid", status: "ready" })));
		const modelList = [{ index: 1, id: "gpt-4", cost: "$0.01" }];
		const params = makeParams({ command: "model", args: "1", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setSessionId).toHaveBeenCalledWith("new-sid");
		expect(params.setModel).toHaveBeenCalledWith("gpt-4");
		expect(params.setStatus).toHaveBeenCalledWith("ready");
	});
});

// ===========================================================================
// 7. handleSessionShortcut
// ===========================================================================

describe("handleSessionShortcut", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSessionShortcut>[0]> = {}) {
		return {
			viewingSubagentId: null as string | null,
			exitSubagentPeekWithScroll: mock(() => {}),
			parentId: null as string | null,
			loadSession: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setView: mock(() => {}),
			...overrides,
		};
	}

	test("with viewingSubagentId, exits subagent peek and clears staged skills", () => {
		const params = makeParams({ viewingSubagentId: "sub-123" });
		handleSessionShortcut(params);

		expect(params.exitSubagentPeekWithScroll).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("with parentId (no viewingSubagentId), loads parent session and clears staged skills", () => {
		const params = makeParams({ parentId: "parent-456" });
		handleSessionShortcut(params);

		expect(params.loadSession).toHaveBeenCalledWith("parent-456");
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setView).toHaveBeenCalledTimes(1);
		expect(params.exitSubagentPeekWithScroll).not.toHaveBeenCalled();
	});

	test("viewingSubagentId takes priority over parentId", () => {
		const params = makeParams({
			viewingSubagentId: "sub-123",
			parentId: "parent-456",
		});
		handleSessionShortcut(params);

		expect(params.exitSubagentPeekWithScroll).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("with neither viewingSubagentId nor parentId, does nothing", () => {
		const params = makeParams();
		handleSessionShortcut(params);

		expect(params.exitSubagentPeekWithScroll).not.toHaveBeenCalled();
		expect(params.loadSession).not.toHaveBeenCalled();
		expect(params.setStagedSkills).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 8. handleSlashCommand
// ===========================================================================

describe("handleSlashCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSlashCommand>[0]> = {}) {
		return {
			name: "test-skill",
			stagedSkills: [] as { name: string; content: string }[],
			setStagedSkills: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("deduplicates: if skill is already staged, does not fetch", () => {
		const params = makeParams({
			name: "existing",
			stagedSkills: [{ name: "existing", content: "..." }],
		});
		handleSlashCommand(params);

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(params.setStagedSkills).not.toHaveBeenCalled();
	});

	test("fetches POST /bobai/skill with skill name", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ name: "test-skill", content: "skill content" })));
		const params = makeParams();
		handleSlashCommand(params);

		expect(globalThis.fetch).toHaveBeenCalledWith("/bobai/skill", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "test-skill" }),
		});
	});

	test("on success, adds skill to staged skills via updater", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ name: "test-skill", content: "skill content" })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();

		expect(params.setStagedSkills).toHaveBeenCalledTimes(1);
		// setStagedSkills is called with an updater function
		const updater = extractUpdater<SkillUpdater>(params.setStagedSkills);
		const result = updater([{ name: "prev", content: "prev content" }]);
		expect(result).toEqual([
			{ name: "prev", content: "prev content" },
			{ name: "test-skill", content: "skill content" },
		]);
	});

	test("on non-ok response, does not add skill", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response("Not found", { status: 404 })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();

		expect(params.setStagedSkills).not.toHaveBeenCalled();
	});

	test("on fetch error, silently ignores", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();

		expect(params.setStagedSkills).not.toHaveBeenCalled();
	});

	test("successful staging adds volatile info message", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ name: "test-skill", content: "content" })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("▸ Staging test-skill skill", "info");
	});

	test("does not deduplicate against different skill names", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ name: "new-skill", content: "new content" })));
		const params = makeParams({
			name: "new-skill",
			stagedSkills: [{ name: "other-skill", content: "..." }],
		});
		handleSlashCommand(params);
		await flushPromises();

		expect(globalThis.fetch).toHaveBeenCalled();
		expect(params.setStagedSkills).toHaveBeenCalledTimes(1);
	});
});
