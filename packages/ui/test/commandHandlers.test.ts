import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	handleConfigurationCommand,
	handleLimitCommand,
	handleModelCommand,
	handleNewCommand,
	handleProviderCommand,
	handleSessionCommand,
	handleSessionShortcut,
	handleSlashCommand,
	handleSubagentCommand,
	handleTitleCommand,
	handleViewCommand,
} from "../src/commandHandlers";

function makeModel(index: number, id: string, cost: string, contextWindow = 0) {
	return { index, id, cost, contextWindow };
}

function makeProvider(index: number, id: string, runtimeSupported = true) {
	return { index, id, runtimeSupported };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractUpdater<T>(fn: (...args: T[]) => unknown): T {
	return fn.mock.calls[0][0];
}

type ViewState = { mode: string; lineLimit: number };
type ViewUpdater = (prev: ViewState) => ViewState;
type SkillEntry = { name: string; content: string };
type SkillUpdater = (prev: SkillEntry[]) => SkillEntry[];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function flushPromises(): Promise<void> {
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
// 1. handleNewCommand
// ===========================================================================

describe("handleNewCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleNewCommand>[0]> = {}) {
		return {
			newChat: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setStatus: mock(() => {}),
			defaultStatus: "Select a provider",
			setProvider: mock(() => {}),
			defaultProvider: null,
			setModel: mock(() => {}),
			defaultModel: null,
			setView: mock(() => {}),
			setTitle: mock(() => {}),
			pendingNewTitle: { current: null },
			setWelcomeMarkdown: mock(() => {}),
			newTitle: "",
			...overrides,
		};
	}

	test("calls newChat, clears staged skills, resets backend defaults, and sets view to chat", () => {
		const params = makeParams();
		handleNewCommand(params);
		expect(params.newChat).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setStatus).toHaveBeenCalledWith("Select a provider");
		expect(params.setProvider).toHaveBeenCalledWith(null);
		expect(params.setModel).toHaveBeenCalledWith(null);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "compaction", lineLimit: 0 })).toEqual({ mode: "chat", lineLimit: 0 });
	});

	test("when no backend defaults exist, resets provider/model to null and keeps select-provider status", () => {
		const params = makeParams({ defaultStatus: "Select a provider" });
		handleNewCommand(params);
		expect(params.setProvider).toHaveBeenCalledWith(null);
		expect(params.setModel).toHaveBeenCalledWith(null);
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
		expect(params.setTitle).toHaveBeenCalledTimes(0);
	});

	test("fetches /bobai/welcome and calls setWelcomeMarkdown on success", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ markdown: "# Welcome" })));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();
		expect(params.setWelcomeMarkdown).toHaveBeenCalledWith("# Welcome");
	});

	test("does not call setWelcomeMarkdown when markdown is empty", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ markdown: "" })));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();
		expect(params.setWelcomeMarkdown).toHaveBeenCalledTimes(0);
	});

	test("silently ignores fetch failure for /bobai/welcome", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams();
		handleNewCommand(params);
		await flushPromises();
		expect(params.setWelcomeMarkdown).toHaveBeenCalledTimes(0);
	});
});

// ===========================================================================
// 2. handleViewCommand
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

	test('arg="1" sets view to chat', () => {
		const params = makeParams({ arg: "1" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "context", lineLimit: 0 })).toEqual({ mode: "chat", lineLimit: 0 });
	});

	test('arg="2" sets view to context and calls fetchContext', () => {
		const params = makeParams({ arg: "2" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "chat", lineLimit: 0 })).toEqual({ mode: "context", lineLimit: 0 });
		expect(params.fetchContext).toHaveBeenCalledTimes(1);
	});

	test('arg="3" sets view to compaction and calls fetchCompactedContext', () => {
		const params = makeParams({ arg: "3" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "chat", lineLimit: 0 })).toEqual({ mode: "compaction", lineLimit: 0 });
		expect(params.fetchCompactedContext).toHaveBeenCalledTimes(1);
	});

	test("empty arg cycles from chat to context", () => {
		const params = makeParams({ arg: "" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "chat", lineLimit: 0 })).toEqual({ mode: "context", lineLimit: 0 });
	});

	test("empty arg cycles from context to compaction", () => {
		const params = makeParams({ arg: "" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "context", lineLimit: 0 })).toEqual({ mode: "compaction", lineLimit: 0 });
	});

	test("empty arg cycles from compaction to chat", () => {
		const params = makeParams({ arg: "" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "compaction", lineLimit: 0 })).toEqual({ mode: "chat", lineLimit: 0 });
	});

	test("invalid arg keeps current mode", () => {
		const params = makeParams({ arg: "99" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "context", lineLimit: 0 })).toEqual({ mode: "context", lineLimit: 0 });
	});

	test("lineLimit is preserved through mode changes", () => {
		const params = makeParams({ arg: "2" });
		handleViewCommand(params);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "chat", lineLimit: 42 })).toEqual({ mode: "context", lineLimit: 42 });
	});

	test("scrolls to bottom after switching view via requestAnimationFrame", async () => {
		const params = makeParams({ arg: "1" });
		handleViewCommand(params);
		await new Promise((r) => setTimeout(r, 0));
		expect(params.scrollToBottom).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// 3. handleModelCommand
// ===========================================================================

describe("handleModelCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleModelCommand>[0]> = {}) {
		return {
			args: "",
			currentProvider: "github-copilot",
			modelListProvider: "github-copilot",
			modelList: null,
			getSessionId: () => "s1",
			setSessionId: mock(() => {}),
			setProvider: mock(() => {}),
			setModel: mock(() => {}),
			setStatus: mock(() => {}),
			setContextLimit: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			clearVolatileMessages: mock(() => {}),
			...overrides,
		};
	}

	test("sends POST to /bobai/command with correct body", () => {
		const params = makeParams({
			args: "1",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.command).toBe("model");
		expect(body.args).toBe("1");
		expect(body.sessionId).toBe("s1");
	});

	test("requires selecting a provider first", () => {
		const params = makeParams({ args: "1", currentProvider: null });
		handleModelCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Select a provider before selecting a model", "error");
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("model text submit posts the resolved numeric index, not the raw query", () => {
		const params = makeParams({
			args: "gpt",
			currentProvider: "github-copilot",
			modelListProvider: "github-copilot",
			modelList: [makeModel(1, "gpt-4o", "1x"), makeModel(2, "claude-sonnet", "1x")],
		});
		handleModelCommand(params);
		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.args).toBe("1");
	});

	test("model submit skips stale model list from the previous provider and posts the numeric index unchanged", () => {
		const params = makeParams({
			args: "2",
			currentProvider: "openrouter",
			modelListProvider: "github-copilot",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.args).toBe("2");
	});

	test("on success: sets sessionId, provider, model, context limit, status, and volatile message", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				jsonResponse({
					ok: true,
					sessionId: "new-s1",
					provider: "github-copilot",
					model: "gpt-4o",
					status: "github-copilot gpt-4o",
				}),
			),
		);
		const params = makeParams({
			args: "1",
			currentProvider: "github-copilot",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		await flushPromises();
		expect(params.setSessionId).toHaveBeenCalledWith("new-s1");
		expect(params.setProvider).toHaveBeenCalledWith("github-copilot");
		expect(params.setModel).toHaveBeenCalledWith("gpt-4o");
		expect(params.setStatus).toHaveBeenCalledWith("github-copilot gpt-4o");
		expect(params.setContextLimit).toHaveBeenCalledWith(null);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Using github-copilot gpt-4o model", "info");
	});

	test("on success without status, does not call setStatus", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, sessionId: "s1" })));
		const params = makeParams({ args: "1", modelList: [makeModel(1, "gpt-4o", "1x")] });
		handleModelCommand(params);
		await flushPromises();
		expect(params.setStatus).toHaveBeenCalledTimes(0);
	});

	test("on failure (ok: false) with error, sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false, error: "bad" })));
		const params = makeParams({ args: "1", modelList: [makeModel(1, "gpt-4o", "1x")] });
		handleModelCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("bad", "error");
	});

	test("on failure (ok: false) without error field, uses fallback", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams({ args: "1", modelList: [makeModel(1, "gpt-4o", "1x")] });
		handleModelCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Command failed", "error");
	});

	test("on fetch error, sets volatile error with generic message", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams({ args: "1", modelList: [makeModel(1, "gpt-4o", "1x")] });
		handleModelCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});

	test("model text submit with no match does not post raw text and shows existing error behavior", () => {
		const params = makeParams({
			args: "unknown",
			currentProvider: "github-copilot",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No model matching "unknown"', "error");
	});

	test("model numeric submit with invalid index still posts to server for server-style invalid-index error", () => {
		const params = makeParams({
			args: "99",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("model text submit with match resolves and shows info message", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ ok: true, model: "gpt-4o", provider: "github-copilot", status: "github-copilot gpt-4o" })),
		);
		const params = makeParams({
			args: "gpt",
			currentProvider: "github-copilot",
			modelListProvider: "github-copilot",
			modelList: [makeModel(1, "gpt-4o", "1x")],
		});
		handleModelCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Using github-copilot gpt-4o model", "info");
	});

	test("includes null sessionId when getSessionId returns null", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
		const params = makeParams({ args: "1", getSessionId: () => null, modelList: [makeModel(1, "gpt-4o", "1x")] });
		handleModelCommand(params);
		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.sessionId).toBeNull();
	});
});

// ===========================================================================
// 4. handleProviderCommand
// ===========================================================================

describe("handleProviderCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleProviderCommand>[0]> = {}) {
		return {
			args: "",
			currentProvider: "github-copilot",
			providerList: null,
			modelList: null,
			getSessionId: () => "s1",
			setSessionId: mock(() => {}),
			setProvider: mock(() => {}),
			setModel: mock(() => {}),
			setStatus: mock(() => {}),
			setContextLimit: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			clearVolatileMessages: mock(() => {}),
			...overrides,
		};
	}

	test("provider command updates provider, model, and status from server result", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				jsonResponse({
					ok: true,
					sessionId: "new-s1",
					provider: "github-copilot",
					status: "github-copilot",
				}),
			),
		);
		const params = makeParams({ args: "1", providerList: [makeProvider(1, "github-copilot")] });
		handleProviderCommand(params);
		await flushPromises();
		expect(params.setProvider).toHaveBeenCalledWith("github-copilot");
		expect(params.setModel).toHaveBeenCalledWith(null);
		expect(params.setContextLimit).toHaveBeenCalledWith(null);
		expect(params.setStatus).toHaveBeenCalledWith("github-copilot");
	});

	test("provider text submit posts the resolved numeric index, not the raw query", () => {
		const params = makeParams({
			args: "copilot",
			providerList: [makeProvider(1, "github-copilot"), makeProvider(2, "openrouter")],
		});
		handleProviderCommand(params);
		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.args).toBe("1");
	});

	test("provider text submit with no match does not post raw text and shows a provider-specific error", () => {
		const params = makeParams({
			args: "unknown",
			providerList: [makeProvider(1, "github-copilot")],
		});
		handleProviderCommand(params);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No provider matching "unknown"', "error");
	});

	test("provider command can be submitted when no provider/model is selected yet", () => {
		const params = makeParams({
			args: "1",
			currentProvider: "github-copilot",
			providerList: [makeProvider(1, "github-copilot")],
		});
		handleProviderCommand(params);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("on failure (ok: false) with error, sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false, error: "Invalid" })));
		const params = makeParams({ args: "99", providerList: [makeProvider(1, "gh")] });
		handleProviderCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid", "error");
	});

	test("on fetch error, sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams({ args: "1", providerList: [makeProvider(1, "gh")] });
		handleProviderCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});
});

// ===========================================================================
// 5. handleTitleCommand
// ===========================================================================

describe("handleTitleCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleTitleCommand>[0]> = {}) {
		return {
			args: "My Title",
			getSessionId: () => "s1",
			setSessionId: mock(() => {}),
			setTitle: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			clearVolatileMessages: mock(() => {}),
			...overrides,
		};
	}

	test("sets title on success", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, sessionId: "s1" })));
		const params = makeParams();
		handleTitleCommand(params);
		await flushPromises();
		expect(params.setTitle).toHaveBeenCalledWith("My Title");
	});

	test("on fetch error, sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams();
		handleTitleCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});
});

// ===========================================================================
// 6. handleLimitCommand
// ===========================================================================

describe("handleLimitCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleLimitCommand>[0]> = {}) {
		return {
			args: "20000",
			getSessionId: () => "s1",
			setSessionId: mock(() => {}),
			setStatus: mock(() => {}),
			setContextLimit: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			clearVolatileMessages: mock(() => {}),
			...overrides,
		};
	}

	test("sets context limit on success", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, contextLimit: 20000, status: "20000" })));
		const params = makeParams();
		handleLimitCommand(params);
		await flushPromises();
		expect(params.setContextLimit).toHaveBeenCalledWith(20000);
		expect(params.setStatus).toHaveBeenCalledWith("20000");
	});

	test("handles null context limit", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, contextLimit: null, status: "cleared" })));
		const params = makeParams({ args: "" });
		handleLimitCommand(params);
		await flushPromises();
		expect(params.setContextLimit).toHaveBeenCalledWith(null);
	});

	test("on failure sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false, error: "bad" })));
		const params = makeParams();
		handleLimitCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("bad", "error");
	});

	test("on fetch error, sets volatile error", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams();
		handleLimitCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});
});

// ===========================================================================
// 7. handleSessionCommand
// ===========================================================================

describe("handleSessionCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSessionCommand>[0]> = {}) {
		return {
			arg: "",
			sessionList: null,
			getSessionId: () => null,
			loadSession: mock(() => {}),
			newChat: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setStatus: mock(() => {}),
			defaultStatus: "Select a provider",
			setView: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("empty arg is a no-op", () => {
		const params = makeParams({ arg: "" });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledTimes(0);
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});

	test("null sessionList sets volatile error", () => {
		const params = makeParams({ arg: "1", sessionList: null });
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session list not loaded", "error");
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({
			arg: "99",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid session index: 99", "error");
	});

	test("non-numeric arg triggers text search (no longer treated as invalid index)", () => {
		const params = makeParams({
			arg: "Test",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("delete session owned by another tab sets error", () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "other",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: true }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Cannot delete: session is active in another tab", "error");
	});

	test("delete current session clears state then fetches DELETE", () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "s1",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.newChat).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		expect(params.setStatus).toHaveBeenCalledWith("Select a provider");
		const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/bobai/session/s1");
		expect(opts.method).toBe("DELETE");
	});

	test("delete non-self non-owned session fetches DELETE without clearing state", () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.newChat).toHaveBeenCalledTimes(0);
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/bobai/session/s1");
	});

	test("delete with ok:false sets error from response", async () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		fetchMock.mockImplementation((url: string) => {
			if (url.includes("/bobai/command")) return Promise.resolve(jsonResponse({ ok: false }));
			return Promise.resolve(jsonResponse({ ok: false, error: "Not found" }));
		});
		handleSessionCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Not found", "error");
	});

	test("delete with ok:false and no error field uses fallback message", async () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		fetchMock.mockImplementation((url: string) => {
			if (url.includes("/bobai/command")) return Promise.resolve(jsonResponse({ ok: false }));
			return Promise.resolve(jsonResponse({ ok: false }));
		});
		handleSessionCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to delete session", "error");
	});

	test("delete fetch failure sets volatile error", async () => {
		const params = makeParams({
			arg: "1 delete",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		fetchMock.mockImplementation((url: string) => {
			if (url.includes("/bobai/command")) return Promise.resolve(jsonResponse({ ok: false }));
			return Promise.reject(new Error("fail"));
		});
		handleSessionCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to delete session", "error");
	});

	test("switching to self is a no-op", () => {
		const params = makeParams({
			arg: "1",
			getSessionId: () => "s1",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});

	test("switching to owned-by-other session sets error", () => {
		const params = makeParams({
			arg: "1",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: true }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session is active in another tab", "error");
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});

	test("switching to available session calls loadSession, clears staged skills, and resets view", () => {
		const params = makeParams({
			arg: "1",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
		const updater = extractUpdater<ViewUpdater>(params.setView);
		expect(updater({ mode: "compaction", lineLimit: 0 })).toEqual({ mode: "chat", lineLimit: 0 });
	});

	test("switching to session with null title works", () => {
		const params = makeParams({
			arg: "1",
			sessionList: [{ index: 1, id: "s1", title: null, updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("unknown subcommand sets volatile error", () => {
		const params = makeParams({
			arg: "1 foo",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Unknown subcommand: foo", "error");
	});

	test("text search: loads first fuzzy-visible session", () => {
		const params = makeParams({
			arg: "Alpha",
			sessionList: [
				{ index: 1, id: "s1", title: "Alpha Project", updatedAt: "2023-01-01T00:00:00Z", owned: false },
				{ index: 2, id: "s2", title: "Beta", updatedAt: "2023-01-01T00:00:00Z", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("text search: case-insensitive matching", () => {
		const params = makeParams({
			arg: "alpha",
			sessionList: [{ index: 1, id: "s1", title: "ALPHA PROJECT", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("text search: no match sets volatile error", () => {
		const params = makeParams({
			arg: "nonexistent",
			sessionList: [{ index: 1, id: "s1", title: "Test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No session matching "nonexistent"', "error");
	});

	test("text search: first visible match is self — silently no-op", () => {
		const params = makeParams({
			arg: "Alpha",
			getSessionId: () => "s1",
			sessionList: [{ index: 1, id: "s1", title: "Alpha", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});

	test("text search: first visible match owned by another tab — shows error", () => {
		const params = makeParams({
			arg: "Alpha",
			getSessionId: () => "s2",
			sessionList: [{ index: 1, id: "s1", title: "Alpha", updatedAt: "2023-01-01T00:00:00Z", owned: true }],
		});
		handleSessionCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Session is active in another tab", "error");
	});

	test("text search: arg starting with digit but containing letters uses text search", () => {
		const params = makeParams({
			arg: "1x test",
			sessionList: [{ index: 1, id: "s1", title: "1x test", updatedAt: "2023-01-01T00:00:00Z", owned: false }],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s1");
	});

	test("text search: sessions with null title are excluded", () => {
		const params = makeParams({
			arg: "search",
			sessionList: [
				{ index: 1, id: "s1", title: null, updatedAt: "2023-01-01T00:00:00Z", owned: false },
				{ index: 2, id: "s2", title: "search", updatedAt: "2023-01-01T00:00:00Z", owned: false },
			],
		});
		handleSessionCommand(params);
		expect(params.loadSession).toHaveBeenCalledWith("s2");
	});
});

// ===========================================================================
// 8. handleSubagentCommand
// ===========================================================================

describe("handleSubagentCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSubagentCommand>[0]> = {}) {
		return {
			arg: "",
			subagentList: null,
			subagents: [],
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
		expect(params.addVolatileMessage).toHaveBeenCalledTimes(0);
	});

	test("null subagentList sets volatile error", () => {
		const params = makeParams({ arg: "1", subagentList: null });
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Subagent list not loaded", "error");
	});

	test("invalid index sets volatile error", () => {
		const params = makeParams({
			arg: "99",
			subagentList: [{ index: 1, title: "Task", sessionId: "sub-1" }],
		});
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid subagent index: 99", "error");
	});

	test("text search with no match sets volatile error", () => {
		const params = makeParams({
			arg: "unknown",
			subagentList: [{ index: 1, title: "Task", sessionId: "sub-1" }],
		});
		handleSubagentCommand(params);
		expect(params.addVolatileMessage).toHaveBeenCalledWith('No subagent matching "unknown"', "error");
	});

	test("numeric index with live (running) subagent calls peekSubagentWithScroll", () => {
		const params = makeParams({
			arg: "1",
			subagentList: [{ index: 1, title: "Task", sessionId: "sub-1" }],
			subagents: [{ sessionId: "sub-1", status: "running", model: "", title: "Task" }],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).toHaveBeenCalledWith("sub-1");
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledTimes(0);
	});

	test("numeric index with non-live subagent calls peekSubagentFromDbWithScroll", () => {
		const params = makeParams({
			arg: "1",
			subagentList: [{ index: 1, title: "Task", sessionId: "sub-1" }],
			subagents: [],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledWith("sub-1");
		expect(params.peekSubagentWithScroll).toHaveBeenCalledTimes(0);
	});

	test("text search: first fuzzy-visible live subagent uses live peek", () => {
		const params = makeParams({
			arg: "Task",
			subagentList: [{ index: 1, title: "Task Alfa", sessionId: "sub-1" }],
			subagents: [{ sessionId: "sub-1", status: "running", model: "", title: "Task Alfa" }],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentWithScroll).toHaveBeenCalledWith("sub-1");
	});

	test("text search: first fuzzy-visible completed subagent uses db peek", () => {
		const params = makeParams({
			arg: "Task",
			subagentList: [{ index: 1, title: "Task Alfa", sessionId: "sub-1" }],
			subagents: [],
		});
		handleSubagentCommand(params);
		expect(params.peekSubagentFromDbWithScroll).toHaveBeenCalledWith("sub-1");
	});

	test("clears staged skills on success regardless of live/db path", () => {
		const params = makeParams({
			arg: "1",
			subagentList: [{ index: 1, title: "Task", sessionId: "sub-1" }],
		});
		handleSubagentCommand(params);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});
});

// ===========================================================================
// 9. handleSessionShortcut
// ===========================================================================

describe("handleSessionShortcut", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSessionShortcut>[0]> = {}) {
		return {
			viewingSubagentId: null,
			exitSubagentPeekWithScroll: mock(() => {}),
			parentId: null,
			loadSession: mock(() => {}),
			setStagedSkills: mock(() => {}),
			setView: mock(() => {}),
			...overrides,
		};
	}

	test("with viewingSubagentId, exits subagent peek and clears staged skills", () => {
		const params = makeParams({ viewingSubagentId: "sub-1" });
		handleSessionShortcut(params);
		expect(params.exitSubagentPeekWithScroll).toHaveBeenCalledTimes(1);
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});

	test("with parentId (no viewingSubagentId), loads parent session and clears staged skills", () => {
		const params = makeParams({ parentId: "parent-1" });
		handleSessionShortcut(params);
		expect(params.loadSession).toHaveBeenCalledWith("parent-1");
		expect(params.setStagedSkills).toHaveBeenCalledWith([]);
	});

	test("viewingSubagentId takes priority over parentId", () => {
		const params = makeParams({ viewingSubagentId: "sub-1", parentId: "parent-1" });
		handleSessionShortcut(params);
		expect(params.exitSubagentPeekWithScroll).toHaveBeenCalledTimes(1);
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});

	test("with neither viewingSubagentId nor parentId, does nothing", () => {
		const params = makeParams();
		handleSessionShortcut(params);
		expect(params.exitSubagentPeekWithScroll).toHaveBeenCalledTimes(0);
		expect(params.loadSession).toHaveBeenCalledTimes(0);
	});
});

// ===========================================================================
// 10. handleConfigurationCommand
// ===========================================================================

describe("handleConfigurationCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleConfigurationCommand>[0]> = {}) {
		return {
			command: "configuration",
			args: "project debug true",
			getSessionId: () => "s1",
			addVolatileMessage: mock(() => {}),
			clearVolatileMessages: mock(() => {}),
			...overrides,
		};
	}

	test("on success: clears volatile messages and displays config messages", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				jsonResponse({
					ok: true,
					messages: [{ text: "debug = true", kind: "success" as const }],
				}),
			),
		);
		const params = makeParams();
		handleConfigurationCommand(params);
		await flushPromises();
		expect(params.clearVolatileMessages).toHaveBeenCalledTimes(1);
		expect(params.addVolatileMessage).toHaveBeenCalledWith("debug = true", "success");
	});

	test("on failure: shows error message", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false, error: "Invalid config" })));
		const params = makeParams();
		handleConfigurationCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Invalid config", "error");
	});

	test("on failure without error field: uses fallback", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: false })));
		const params = makeParams();
		handleConfigurationCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Command failed", "error");
	});

	test("on fetch error: shows generic error", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams();
		handleConfigurationCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("Failed to execute command", "error");
	});
});

// ===========================================================================
// 11. handleSlashCommand
// ===========================================================================

describe("handleSlashCommand", () => {
	function makeParams(overrides: Partial<Parameters<typeof handleSlashCommand>[0]> = {}) {
		return {
			name: "my-skill",
			stagedSkills: [],
			setStagedSkills: mock(() => {}),
			addVolatileMessage: mock(() => {}),
			...overrides,
		};
	}

	test("deduplicates: if skill is already staged, does not fetch", () => {
		const params = makeParams({ stagedSkills: [{ name: "my-skill", content: "old" }] });
		handleSlashCommand(params);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("fetches POST /bobai/skill with skill name", () => {
		const params = makeParams();
		handleSlashCommand(params);
		const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/bobai/skill");
		const body = JSON.parse(opts.body as string);
		expect(body.name).toBe("my-skill");
	});

	test("on success, adds skill to staged skills via updater", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ name: "my-skill", content: "abc" })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();
		expect(params.setStagedSkills).toHaveBeenCalledTimes(1);
		const updater = extractUpdater<SkillUpdater>(params.setStagedSkills);
		expect(updater([])).toEqual([{ name: "my-skill", content: "abc" }]);
	});

	test("on non-ok response, does not add skill", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 400 })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();
		expect(params.setStagedSkills).toHaveBeenCalledTimes(0);
	});

	test("on fetch error, silently ignores", async () => {
		fetchMock.mockImplementation(() => Promise.reject(new Error("fail")));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();
		expect(params.setStagedSkills).toHaveBeenCalledTimes(0);
	});

	test("successful staging adds volatile info message", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ name: "my-skill", content: "abc" })));
		const params = makeParams();
		handleSlashCommand(params);
		await flushPromises();
		expect(params.addVolatileMessage).toHaveBeenCalledWith("▸ Staging my-skill skill", "info");
	});

	test("does not deduplicate against different skill names", async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ name: "new-skill", content: "new-content" })));
		const params = makeParams({ name: "new-skill", stagedSkills: [{ name: "other-skill", content: "..." }] });
		handleSlashCommand(params);
		await flushPromises();
		expect(params.setStagedSkills).toHaveBeenCalledTimes(1);
	});
});
