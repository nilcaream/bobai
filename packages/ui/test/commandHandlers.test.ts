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
			setVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("empty arg is a no-op", () => {
		const params = makeParams({ arg: "" });
		handleSessionCommand(params);
		expect(params.setVolatileMessage).not.toHaveBeenCalled();
		expect(params.loadSession).not.toHaveBeenCalled();
	});

	test("null sessionList sets volatile error", () => {
		const params = makeParams({ arg: "1", sessionList: null });
		handleSessionCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Session list not loaded",
			kind: "error",
		});
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({ arg: "99" });
		handleSessionCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Invalid session index: 99",
			kind: "error",
		});
	});

	test("non-numeric index sets volatile error", () => {
		const params = makeParams({ arg: "xyz" });
		handleSessionCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Invalid session index: xyz",
			kind: "error",
		});
	});

	// -- Delete subcommand --

	test("delete session owned by another tab sets error", () => {
		// Session 2 (bbb) is owned=true, and current session is "current-id" (not bbb)
		const params = makeParams({ arg: "2 delete" });
		handleSessionCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Cannot delete: session is active in another tab",
			kind: "error",
		});
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
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: 'Session aaa "Session A" has been removed',
			kind: "success",
		});
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
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Session aaa has been removed",
			kind: "success",
		});
	});

	test("delete with ok:false sets error from response", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false, error: "DB error" })));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "DB error",
			kind: "error",
		});
	});

	test("delete with ok:false and no error field uses fallback message", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Failed to delete session",
			kind: "error",
		});
	});

	test("delete fetch failure sets volatile error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams({ arg: "1 delete" });
		handleSessionCommand(params);
		await flushPromises();

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Failed to delete session",
			kind: "error",
		});
	});

	// -- Session switching --

	test("switching to self is a no-op", () => {
		const params = makeParams({
			arg: "1",
			getSessionId: mock(() => "aaa"),
		});
		handleSessionCommand(params);
		expect(params.loadSession).not.toHaveBeenCalled();
		expect(params.setVolatileMessage).not.toHaveBeenCalled();
	});

	test("switching to owned-by-other session sets error", () => {
		const params = makeParams({ arg: "2" }); // bbb, owned=true
		handleSessionCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Session is active in another tab",
			kind: "error",
		});
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
			setVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("empty arg is a no-op", () => {
		const params = makeParams({ arg: "" });
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).not.toHaveBeenCalled();
		expect(params.peekSubagentFromDbWithScroll).not.toHaveBeenCalled();
		expect(params.setVolatileMessage).not.toHaveBeenCalled();
	});

	test("null subagentList sets volatile error", () => {
		const params = makeParams({ arg: "1", subagentList: null });
		handleSubagentCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Subagent list not loaded",
			kind: "error",
		});
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({ arg: "99" });
		handleSubagentCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Invalid subagent index: 99",
			kind: "error",
		});
	});

	test("non-numeric arg sets volatile error", () => {
		const params = makeParams({ arg: "foo" });
		handleSubagentCommand(params);
		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Invalid subagent index: foo",
			kind: "error",
		});
	});

	test("valid index with live (running) subagent calls peekSubagentWithScroll", () => {
		const params = makeParams({ arg: "1" }); // sub-aaa is running
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).toHaveBeenCalledWith("sub-aaa");
		expect(params.peekSubagentFromDbWithScroll).not.toHaveBeenCalled();
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});

	test("valid index with non-live subagent calls peekSubagentFromDbWithScroll", () => {
		const params = makeParams({ arg: "2" }); // sub-bbb is done
		handleSubagentCommand(params);
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledWith("sub-bbb");
		expect(params.peekSubagentWithScroll).not.toHaveBeenCalled();
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
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
			setVolatileMessage: mock(() => {}),
			modelList: null as { index: number; id: string; cost: string }[] | null,
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

	test('on success with command "model", finds model in list and calls setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [
			{ index: 1, id: "gpt-4", cost: "$0.01" },
			{ index: 2, id: "claude-3", cost: "$0.02" },
		];
		const params = makeParams({ command: "model", args: "2", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).toHaveBeenCalledWith("claude-3");
	});

	test('on success with command "model" but no matching index, does not call setModel', async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: true })));
		const modelList = [{ index: 1, id: "gpt-4", cost: "$0.01" }];
		const params = makeParams({ command: "model", args: "5", modelList });
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setModel).not.toHaveBeenCalled();
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

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Bad command",
			kind: "error",
		});
	});

	test("on failure (ok: false) without error field, uses fallback", async () => {
		globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Command failed",
			kind: "error",
		});
	});

	test("on fetch error, sets volatile error with generic message", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network")));
		const params = makeParams();
		handleGenericCommand(params);
		await flushPromises();

		expect(params.setVolatileMessage).toHaveBeenCalledWith({
			text: "Failed to execute command",
			kind: "error",
		});
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
