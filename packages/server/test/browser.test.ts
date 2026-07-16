/**
 * Tests for browser tools (browser_connect, browser_evaluate, browser_export_session, browser_navigate).
 *
 * Uses global fetch and WebSocket mocking to simulate CDP communication.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectCdp, disconnectCdp, evaluateCdp, exportSessionCdp, navigateCdp } from "../src/tool/browser-cdp";
import { browserCloseTabTool } from "../src/tool/browser-close-tab";
import { browserConnectTool } from "../src/tool/browser-connect";
import { browserEvaluateTool } from "../src/tool/browser-evaluate";
import { browserExportSessionTool } from "../src/tool/browser-export-session";
import { browserNavigateTool } from "../src/tool/browser-navigate";

// ---- Helpers ----

const OG_FETCH = globalThis.fetch;
const OG_WS = globalThis.WebSocket;

function restoreGlobals() {
	globalThis.fetch = OG_FETCH;
	globalThis.WebSocket = OG_WS;
}

/** Type for the mock WebSocket used in tests. */
type MockWebSocket = {
	readyState: number;
	onopen: ((...args: unknown[]) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onerror: ((...args: unknown[]) => void) | null;
	onclose: ((...args: unknown[]) => void) | null;
	send(data: string): void;
	close(): void;
	[key: string]: unknown;
};

/**
 * Set up mock fetch that returns a /json endpoint response with the given tabs.
 * Returns cleanup function.
 */
function mockCdpFetch(port: number, tabs: Array<{ id: string; url: string; title: string }>, supportNavigate = false) {
	globalThis.fetch = ((urlStr: string, _init?: RequestInit) => {
		const url = String(urlStr);

		if (url.includes("/json/new") && supportNavigate) {
			const searchUrl = url.includes("?") ? url.split("?").slice(1).join("?") : "about:blank";
			const decoded = decodeURIComponent(searchUrl);
			const tabId = `tab-new-${Date.now()}`;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: tabId,
						url: decoded,
						title: "New Tab",
						webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/${tabId}`,
						type: "page",
					}),
					{ status: 200 },
				),
			);
		}

		if (url.includes("/json")) {
			return Promise.resolve(
				new Response(
					JSON.stringify(
						tabs.map((t) => ({
							...t,
							webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/${t.id}`,
							type: "page",
						})),
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		}

		return Promise.resolve(new Response("Not found", { status: 404 }));
	}) as unknown as typeof fetch;
}

/**
 * Creates a mock WebSocket that responds to CDP commands.
 */
function createMockCdpWs(responses?: Map<string, (params?: Record<string, unknown>) => unknown>) {
	const resp = responses ?? standardCdpResponses();

	const ws: MockWebSocket = {
		readyState: 0,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		send(data: string) {
			let msg: { id?: number; method?: string; params?: Record<string, unknown> };
			try {
				msg = JSON.parse(data);
			} catch {
				return;
			}
			const { method, params } = msg;
			const id = msg.id ?? 0;

			// Domain enables
			if (method && ["Page.enable", "Runtime.enable", "Network.enable"].includes(method)) {
				queueReply(id, {});
				// After Page.enable, fire load event to simulate an already-loaded page
				if (method === "Page.enable") fireLoadEvent();
				return;
			}

			// Page.navigate fires navigation events (for reuse-based navigation)
			if (method === "Page.navigate") {
				const navHandler = resp.get(method);
				const result = navHandler ? navHandler(params) : { frameId: "fake-1", loaderId: "fake-1" };
				queueReply(id, result);
				fireNavigateEvents();
				return;
			}

			// Look up response
			const handler = resp.get(method ?? "");
			if (handler) {
				queueReply(id, handler(params));
				return;
			}

			queueReply(id, {});
		},
		close() {},
	};

	function queueReply(id: number, result: unknown) {
		setTimeout(() => {
			if (ws.readyState === 1 && ws.onmessage) {
				ws.onmessage({ data: JSON.stringify({ id, result }) });
			}
		}, 0);
	}

	// Track whether we've fired the load event for this connection
	let firedLoadEvent = false;

	function fireLoadEvent() {
		if (firedLoadEvent) return;
		firedLoadEvent = true;
		fireNavigateEvents();
	}

	function fireNavigateEvents() {
		setTimeout(() => {
			if (ws.readyState === 1 && ws.onmessage) {
				ws.onmessage({ data: JSON.stringify({ method: "Page.frameNavigated", params: { frame: {} } }) });
			}
		}, 2);
		setTimeout(() => {
			if (ws.readyState === 1 && ws.onmessage) {
				ws.onmessage({ data: JSON.stringify({ method: "Page.loadEventFired", params: {} }) });
			}
		}, 4);
	}

	// Open connection on next tick
	setTimeout(() => {
		ws.readyState = 1;
		if (ws.onopen) ws.onopen({});
	}, 0);

	return ws;
}

function mockCdpWebSocket(responses?: Map<string, (params?: Record<string, unknown>) => unknown>) {
	const resp = responses ?? standardCdpResponses();
	// Create a constructor that returns fresh mock instances each time
	// biome-ignore lint/complexity/useArrowFunction: must be a regular function for "new" to work
	globalThis.WebSocket = function (_url: string) {
		return createMockCdpWs(resp) as unknown as WebSocket;
	} as unknown as typeof WebSocket;
}

function standardCdpResponses(): Map<string, (params?: Record<string, unknown>) => unknown> {
	const m = new Map<string, (params?: Record<string, unknown>) => unknown>();

	m.set("Runtime.evaluate", (params) => {
		const expr = (params?.expression as string) ?? "";

		if (expr.includes("document.querySelectorAll") || expr.includes("inputs.push")) {
			return {
				result: {
					value: JSON.stringify({
						url: "https://example.com/page",
						title: "Test Page",
						bodyText: "Hello world. Form with search box.",
						inputs: [{ id: "search", name: "q", type: "text", selector: "#search" }],
						buttons: ["Search", "Submit"],
						links: [{ text: "Download PDF", href: "https://example.com/doc.pdf" }],
					}),
				},
			};
		}

		if (expr.includes("localStorage")) {
			return { result: { value: JSON.stringify({ auth_token: "test-token-123", theme: "dark" }) } };
		}

		if (expr.includes("location.href")) {
			return { result: { value: "https://example.com/dashboard" } };
		}

		return { result: { value: "eval-ok" } };
	});

	m.set("Network.getCookies", () => ({
		cookies: [
			{ name: "session", value: "abc123session", domain: ".example.com", path: "/", httpOnly: true, secure: true },
			{ name: "csrftoken", value: "csrf456token", domain: ".example.com", path: "/", httpOnly: false, secure: true },
		],
	}));

	m.set("Page.navigate", () => ({ frameId: "fake-frame-1", loaderId: "fake-loader-1" }));

	return m;
}

// ---- Tests ----

describe("browser CDP client", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	describe("connectCdp", () => {
		test("discovers tabs from CDP endpoint", async () => {
			mockCdpFetch(9222, [
				{ id: "tab-1", url: "https://example.com", title: "Example Page" },
				{ id: "tab-2", url: "https://news.ycombinator.com", title: "Hacker News" },
			]);

			const tabs = await connectCdp("localhost:9222");
			expect(tabs.length).toBe(2);
			expect(tabs[0].title).toBe("Example Page");
			expect(tabs[1].title).toBe("Hacker News");
		});

		test("throws on unreachable endpoint", async () => {
			globalThis.fetch = (() => {
				throw new Error("Connection refused");
			}) as unknown as typeof fetch;

			await expect(connectCdp("localhost:19999")).rejects.toThrow();
		});

		test("returns empty array when no page tabs exist", async () => {
			mockCdpFetch(9223, []);
			const tabs = await connectCdp("localhost:9223");
			expect(tabs).toEqual([]);
		});

		test("filters out non-page targets", async () => {
			globalThis.fetch = (() =>
				Promise.resolve(
					new Response(
						JSON.stringify([
							{ id: "p1", url: "https://example.com", title: "Page", webSocketDebuggerUrl: "ws://x", type: "page" },
							{ id: "w1", url: "ws://x", title: "Worker", webSocketDebuggerUrl: "ws://x", type: "worker" },
						]),
						{ status: 200 },
					),
				)) as unknown as typeof fetch;

			const tabs = await connectCdp("localhost:9222");
			expect(tabs.length).toBe(1);
			expect(tabs[0].title).toBe("Page");
		});
	});

	describe("evaluateCdp", () => {
		test("evaluates JS and returns result with page snapshot", async () => {
			mockCdpFetch(9224, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			mockCdpWebSocket();

			await connectCdp("localhost:9224");
			const result = await evaluateCdp({ tabName: "Example" }, "document.title");

			expect(result.result).toBe("eval-ok");
			expect(result.page).toBeDefined();
			expect(result.page.title).toBe("Test Page");
			expect(result.page.inputs).toBeArray();
			expect(result.page.buttons).toContain("Search");
		});

		test("throws on missing tab", async () => {
			mockCdpFetch(9225, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			mockCdpWebSocket();
			await connectCdp("localhost:9225");

			await expect(evaluateCdp({ tabName: "nonexistent" }, "1 + 1")).rejects.toThrow(/No tab found/);
		});

		test("throws when no connection established", async () => {
			disconnectCdp();
			await expect(evaluateCdp({ tabName: "Example" }, "1 + 1")).rejects.toThrow(/No tab found/);
		});
	});

	describe("exportSessionCdp", () => {
		test("extracts cookies and localStorage", async () => {
			mockCdpFetch(9226, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			mockCdpWebSocket();
			await connectCdp("localhost:9226");

			const session = await exportSessionCdp({ tabName: "Example" });
			expect(session.origin).toBe("https://example.com");
			expect(session.curlCookie).toContain("session=abc123session");
			expect(session.curlCookie).toContain("csrftoken=csrf456token");
			expect(session.raw.cookies.length).toBe(2);
			expect(session.raw.cookies[0].httpOnly).toBe(true);
		});

		test("extracts auth token from localStorage into headers", async () => {
			mockCdpFetch(9227, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			mockCdpWebSocket();
			await connectCdp("localhost:9227");

			const session = await exportSessionCdp({ tabName: "Example" });
			expect(session.headers.Authorization).toBe("Bearer test-token-123");
		});
	});

	describe("navigateCdp", () => {
		test("creates a new tab and returns snapshot", async () => {
			mockCdpFetch(9228, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }], true);
			mockCdpWebSocket();
			await connectCdp("localhost:9228");

			const result = await navigateCdp("https://example.com/new-page");
			expect(result.tabId).toBeString();
			expect(result.tabId).toStartWith("tab-new-");
			expect(result.snapshot).toBeDefined();
		});

		test("throws when no connection established", async () => {
			await expect(navigateCdp("https://example.com")).rejects.toThrow(/No CDP connection/);
		});
	});

	describe("resolveTab", () => {
		test("resolves by title substring", async () => {
			mockCdpFetch(9229, [
				{ id: "tab-1", url: "https://example.com", title: "Example Page" },
				{ id: "tab-2", url: "https://news.ycombinator.com", title: "Hacker News" },
			]);
			await connectCdp("localhost:9229");
			const { resolveTab } = await import("../src/tool/browser-cdp");
			const tab = resolveTab({ tabName: "Hacker" });
			expect(tab.title).toBe("Hacker News");
		});

		test("resolves by URL substring", async () => {
			mockCdpFetch(9230, [
				{ id: "tab-1", url: "https://example.com", title: "Example Page" },
				{ id: "tab-2", url: "https://news.ycombinator.com", title: "Hacker News" },
			]);
			await connectCdp("localhost:9230");
			const { resolveTab } = await import("../src/tool/browser-cdp");
			const tab = resolveTab({ tabUrl: "ycombinator" });
			expect(tab.url).toBe("https://news.ycombinator.com");
		});

		test("throws on ambiguous match", async () => {
			mockCdpFetch(9231, [
				{ id: "tab-1", url: "https://a.com", title: "Hacker News" },
				{ id: "tab-2", url: "https://b.com", title: "Hacker News Daily" },
			]);
			await connectCdp("localhost:9231");
			const { resolveTab } = await import("../src/tool/browser-cdp");
			expect(() => resolveTab({ tabName: "Hacker" })).toThrow(/Multiple tabs match/);
		});

		test("auto-selects first tab after connect", async () => {
			mockCdpFetch(9232, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			await connectCdp("localhost:9232");
			const { resolveTab } = await import("../src/tool/browser-cdp");
			// Should resolve to the auto-selected first tab without explicit spec
			const tab = resolveTab();
			expect(tab.id).toBe("tab-1");
			expect(tab.title).toBe("Example Page");
		});

		test("rejects tab index 0 as out of range", async () => {
			const { resolveTab } = await import("../src/tool/browser-cdp");
			expect(() => resolveTab({ tabIndex: 0 })).toThrow(/out of range/);
		});
	});

	describe("disconnectCdp", () => {
		test("clears all state", async () => {
			mockCdpFetch(9233, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
			await connectCdp("localhost:9233");
			const { getActiveEndpoint, getDiscoveredTabs, getActiveTabId } = await import("../src/tool/browser-cdp");

			expect(getActiveEndpoint()).toBe("localhost:9233");
			expect(getDiscoveredTabs().length).toBe(1);
			expect(getActiveTabId()).toBe("tab-1");

			disconnectCdp();
			expect(getActiveEndpoint()).toBeNull();
			expect(getDiscoveredTabs()).toEqual([]);
			expect(getActiveTabId()).toBeNull();
		});
	});
});

// ---- Tool-level tests ----

describe("browserConnectTool", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("returns tab list on successful connect", async () => {
		mockCdpFetch(9240, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		const result = await browserConnectTool.execute({ endpoint: "localhost:9240" }, {});
		expect(result.llmOutput).toContain("Connected to");
		expect(result.llmOutput).toContain("Example Page");
	});

	test("returns error for empty endpoint", async () => {
		const result = await browserConnectTool.execute({ endpoint: "" }, {});
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("required");
	});

	test("returns error for unreachable endpoint", async () => {
		globalThis.fetch = (() => {
			throw new Error("Connection refused");
		}) as unknown as typeof fetch;
		const result = await browserConnectTool.execute({ endpoint: "localhost:19999" }, {});
		expect(result.llmOutput).toContain("Error");
	});

	test("formatCall shows endpoint", () => {
		expect(browserConnectTool.formatCall({ endpoint: "localhost:9222" })).toContain("localhost:9222");
	});
});

describe("browserEvaluateTool", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("wraps expression with return so values are captured", async () => {
		// Capture all expressions sent to Runtime.evaluate — there are multiple
		// calls (user expr, snapshot, isTabAlive ping). We care about the first one
		// that contains the user expression.
		const capturedExpressions: string[] = [];

		const responses = standardCdpResponses();
		responses.set("Runtime.evaluate", (params) => {
			const expr = (params?.expression as string) ?? "";
			capturedExpressions.push(expr);

			// Simulate CDP: if the wrapped expression uses return(), the Promise resolves
			// to a value; if it's a block body {}, the Promise resolves to undefined.
			const usesReturn = expr.includes("return (");
			return {
				result: {
					value: usesReturn ? "title-value" : undefined,
				},
			};
		});

		mockCdpFetch(9241, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket(responses);
		await browserConnectTool.execute({ endpoint: "localhost:9241" }, {});

		const result = await browserEvaluateTool.execute({ tab: "Example", expression: "document.title" }, {});

		// Find the expression that contains the user's code (not snapshot, not ping)
		const userEval = capturedExpressions.find((e) => e.includes("document.title"));
		expect(userEval).toBeDefined();

		// The wrapper must include "return" so the value is captured
		expect(userEval).toContain("return");
		// Result should NOT say "(no return value)" — the value IS returned
		expect(result.llmOutput).not.toContain("(no return value)");
		expect(result.llmOutput).toContain("title-value");
	});

	test("does not wrap throw expressions with return", async () => {
		const capturedExpressions: string[] = [];

		const responses = standardCdpResponses();
		responses.set("Runtime.evaluate", (params) => {
			capturedExpressions.push((params?.expression as string) ?? "");
			return {
				exceptionDetails: {
					text: "Uncaught (in promise) Error: boom",
					exception: { description: "Error: boom" },
				},
			};
		});

		mockCdpFetch(9291, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket(responses);
		await browserConnectTool.execute({ endpoint: "localhost:9291" }, {});

		const result = await browserEvaluateTool.execute({ tab: "Example", expression: "throw new Error('boom')" }, {});

		// Find the expression that contains the user's code
		const userEval = capturedExpressions.find((e) => e.includes("throw new Error"));
		expect(userEval).toBeDefined();

		// throw statements should NOT be wrapped with return() — that would be a syntax error
		expect(userEval).not.toContain("return (");
		// Errors should propagate through the exceptionDetails path
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("boom");
	});

	test("executes expression and returns result with page context", async () => {
		mockCdpFetch(9292, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket();
		await browserConnectTool.execute({ endpoint: "localhost:9292" }, {});

		const result = await browserEvaluateTool.execute({ tab: "Example", expression: "document.title" }, {});
		expect(result.llmOutput).toContain("eval-ok");
		expect(result.llmOutput).toContain("Test Page");
		// Default label when not provided
		expect(result.uiOutput).toStartWith("▸ Running script");
	});

	test("uses explicit label when provided", async () => {
		mockCdpFetch(9290, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket();
		await browserConnectTool.execute({ endpoint: "localhost:9290" }, {});

		const result = await browserEvaluateTool.execute(
			{ tab: "Example", expression: "document.querySelector('button').click()", label: "Clicking submit button" },
			{},
		);
		expect(result.uiOutput).toStartWith("▸ Clicking submit button");
	});

	test("returns error for empty expression", async () => {
		const result = await browserEvaluateTool.execute({ expression: "" }, {});
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("required");
	});

	test("returns error when not connected", async () => {
		disconnectCdp();
		const result = await browserEvaluateTool.execute({ tab: "Example", expression: "1 + 1" }, {});
		expect(result.llmOutput).toContain("Error");
	});

	test("formatCall shows running label", () => {
		expect(browserEvaluateTool.formatCall({ tab: "News", expression: "document.title" })).toStartWith(
			"▸ Running browser script",
		);
	});
});

describe("browserExportSessionTool", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("extracts session data", async () => {
		mockCdpFetch(9242, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket();
		await browserConnectTool.execute({ endpoint: "localhost:9242" }, {});

		const result = await browserExportSessionTool.execute({ tab: "Example" }, {});
		expect(result.llmOutput).toContain("example.com");
		expect(result.llmOutput).toContain("session=abc123session");
		expect(result.llmOutput).toContain("HttpOnly");
	});

	test("returns error when not connected", async () => {
		disconnectCdp();
		const result = await browserExportSessionTool.execute({ tab: "Example" }, {});
		expect(result.llmOutput).toContain("Error");
	});
});

describe("browserNavigateTool", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("opens new tab and returns page content", async () => {
		mockCdpFetch(9243, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }], true);
		mockCdpWebSocket();
		await browserConnectTool.execute({ endpoint: "localhost:9243" }, {});

		const result = await browserNavigateTool.execute({ url: "https://example.com/login" }, {});
		expect(result.llmOutput).toContain("Opened new tab");
		expect(result.llmOutput).toContain("https://example.com/login");
		expect(result.metadata?.tabId).toBeString();
	});

	test("rejects non-HTTP URLs", async () => {
		const result = await browserNavigateTool.execute({ url: "ftp://example.com" }, {});
		expect(result.llmOutput).toContain("Error");
	});

	test("returns error when not connected", async () => {
		disconnectCdp();
		const result = await browserNavigateTool.execute({ url: "https://example.com" }, {});
		expect(result.llmOutput).toContain("Error");
	});
});

describe("browserNavigateTool with reuse", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("reuses active tab when reuse is true", async () => {
		mockCdpFetch(9244, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }], true);
		mockCdpWebSocket();
		await browserConnectTool.execute({ endpoint: "localhost:9244" }, {});

		const result = await browserNavigateTool.execute({ url: "https://example.com/other", reuse: true }, {});

		expect(result.llmOutput).toContain("Opened new tab");
		expect(result.metadata?.tabId).toBe("tab-1");
	});
});

// ---- closeTabCdp ----

describe("closeTabCdp", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("closes a tab and removes it from discovered list", async () => {
		// Set up fetch that supports /json, /json/new, and /json/close
		globalThis.fetch = ((urlStr: string, _init?: RequestInit) => {
			const url = String(urlStr);
			if (url.includes("/json/close/")) {
				return Promise.resolve(new Response("Target is closing", { status: 200 }));
			}
			if (url.includes("/json/new")) {
				const decoded = url.includes("?") ? decodeURIComponent(url.split("?").slice(1).join("?")) : "about:blank";
				return Promise.resolve(
					new Response(
						JSON.stringify({
							id: "tab-new",
							url: decoded,
							title: "New Tab",
							webSocketDebuggerUrl: "ws://localhost:9245/devtools/page/tab-new",
							type: "page",
						}),
						{ status: 200 },
					),
				);
			}
			if (url.includes("/json")) {
				return Promise.resolve(
					new Response(
						JSON.stringify([
							{
								id: "tab-1",
								url: "https://example.com",
								title: "Example",
								webSocketDebuggerUrl: "ws://localhost:9245/devtools/page/tab-1",
								type: "page",
							},
							{
								id: "tab-2",
								url: "https://other.com",
								title: "Other",
								webSocketDebuggerUrl: "ws://localhost:9245/devtools/page/tab-2",
								type: "page",
							},
						]),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as unknown as typeof fetch;

		await connectCdp("localhost:9245");
		const { closeTabCdp, getDiscoveredTabs } = await import("../src/tool/browser-cdp");
		expect(getDiscoveredTabs().length).toBe(2);

		await closeTabCdp({ tabName: "Example" });
		expect(getDiscoveredTabs().length).toBe(1);
		expect(getDiscoveredTabs()[0].title).toBe("Other");
	});

	test("throws when no tab matches", async () => {
		globalThis.fetch = ((urlStr: string, _init?: RequestInit) => {
			const url = String(urlStr);
			if (url.includes("/json")) {
				return Promise.resolve(
					new Response(
						JSON.stringify([
							{
								id: "tab-1",
								url: "https://example.com",
								title: "Example",
								webSocketDebuggerUrl: "ws://localhost:9246/devtools/page/tab-1",
								type: "page",
							},
						]),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as unknown as typeof fetch;

		await connectCdp("localhost:9246");
		const { closeTabCdp } = await import("../src/tool/browser-cdp");
		await expect(closeTabCdp({ tabName: "nonexistent" })).rejects.toThrow(/No tab found/);
	});
});

// ---- browserCloseTabTool ----

describe("browserCloseTabTool", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("closes a tab by name", async () => {
		globalThis.fetch = ((urlStr: string, _init?: RequestInit) => {
			const url = String(urlStr);
			if (url.includes("/json/close/")) {
				return Promise.resolve(new Response("Target is closing", { status: 200 }));
			}
			if (url.includes("/json")) {
				return Promise.resolve(
					new Response(
						JSON.stringify([
							{
								id: "tab-1",
								url: "https://example.com",
								title: "Example",
								webSocketDebuggerUrl: "ws://localhost:9247/devtools/page/tab-1",
								type: "page",
							},
						]),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}) as unknown as typeof fetch;

		await browserConnectTool.execute({ endpoint: "localhost:9247" }, {});

		const result = await browserCloseTabTool.execute({ tab: "Example" }, {});

		expect(result.llmOutput).toContain("Closed tab");
		expect(result.llmOutput).toContain("Example");
	});

	test("returns error when not connected", async () => {
		disconnectCdp();
		const result = await browserCloseTabTool.execute({ tab: "Example" }, {});
		expect(result.llmOutput).toContain("Error");
	});
});

// ---- accessibility tree ----

describe("accessibility tree snapshot", () => {
	afterEach(() => {
		disconnectCdp();
		restoreGlobals();
	});

	test("evaluateCdp includes accessibility tree when snapshot option is accessibility", async () => {
		const responses = standardCdpResponses();
		responses.set("Accessibility.getFullAXTree", () => ({
			nodes: [
				{ nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Test Page" } },
				{ nodeId: "2", ignored: false, role: { value: "button" }, name: { value: "Search" } },
			],
		}));

		mockCdpFetch(9248, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket(responses);
		await connectCdp("localhost:9248");

		const { evaluateCdp: evalFn } = await import("../src/tool/browser-cdp");
		const result = await evalFn({ tabName: "Example" }, "document.title", undefined, {
			snapshot: "accessibility",
		});

		expect(result.result).toBe("eval-ok");
		expect(result.page.accessibilityTree).toBeDefined();
		expect(result.page.accessibilityTree).toContain("RootWebArea");
	});

	test("evaluateCdp does not include accessibility tree when snapshot is elements", async () => {
		const responses = standardCdpResponses();
		responses.set("Accessibility.getFullAXTree", () => ({
			nodes: [],
		}));

		mockCdpFetch(9249, [{ id: "tab-1", url: "https://example.com", title: "Example Page" }]);
		mockCdpWebSocket(responses);
		await connectCdp("localhost:9249");

		const { evaluateCdp: evalFn } = await import("../src/tool/browser-cdp");
		const result = await evalFn({ tabName: "Example" }, "document.title");

		expect(result.page.accessibilityTree).toBeUndefined();
	});
});

// ---- Tool metadata ----

describe("browser tool metadata", () => {
	test("browser_connect has correct name", () => {
		expect(browserConnectTool.definition.function.name).toBe("browser_connect");
	});
	test("browser_evaluate has correct name", () => {
		expect(browserEvaluateTool.definition.function.name).toBe("browser_evaluate");
	});
	test("browser_export_session has correct name", () => {
		expect(browserExportSessionTool.definition.function.name).toBe("browser_export_session");
	});
	test("browser_navigate has correct name", () => {
		expect(browserNavigateTool.definition.function.name).toBe("browser_navigate");
	});
	test("browser_close_tab has correct name", () => {
		expect(browserCloseTabTool.definition.function.name).toBe("browser_close_tab");
	});
});
