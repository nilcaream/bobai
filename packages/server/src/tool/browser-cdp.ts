/**
 * Browser CDP client — communicates with Chrome via Chrome DevTools Protocol.
 *
 * Maintains a single active connection to a Chrome debug endpoint.
 * Tools (browser_connect, browser_navigate, browser_evaluate, browser_export_session)
 * are thin wrappers that call into this module.
 *
 * Per-tab serialization ensures only one evaluate/operation runs on a given tab at a time.
 * Auto-wait after navigation: on Page.frameNavigated, the tab is marked "navigating";
 * the next evaluate waits for Page.loadEventFired before executing.
 */

const SNAPSHOT_SCRIPT = `
(function() {
  try {
    var inputs = [];
    var all = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
    for (var i = 0; i < all.length && inputs.length < 5; i++) {
      var el = all[i];
      inputs.push({
        id: el.id || '',
        name: el.name || '',
        type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase(),
        selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase())
      });
    }
    var buttons = [];
    var btnEls = document.querySelectorAll('button, input[type="submit"], [role="button"]');
    for (var j = 0; j < btnEls.length && buttons.length < 5; j++) {
      var t = (btnEls[j].textContent || btnEls[j].getAttribute('value') || btnEls[j].getAttribute('aria-label') || '').trim();
      if (t && t.length < 200) buttons.push(t);
    }
    var links = [];
    var seen = {};
    var linkEls = document.querySelectorAll('a[href]');
    for (var k = 0; k < linkEls.length && links.length < 5; k++) {
      var a = linkEls[k];
      var href = a.getAttribute('href') || '';
      if (href && href.indexOf('#') !== 0 && href.indexOf('javascript:') !== 0) {
        if (!seen[href]) {
          seen[href] = true;
          links.push({ text: (a.textContent || '').trim().slice(0, 100), href: href });
        }
      }
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      bodyText: (document.body ? document.body.innerText : '').slice(0, 5000),
      inputs: inputs,
      buttons: buttons,
      links: links
    });
  } catch (e) {
    return JSON.stringify({ url: location.href, title: document.title, bodyText: '', inputs: [], buttons: [], links: [], _error: e.message });
  }
})()
`;

export interface CdpTab {
	id: string;
	url: string;
	title: string;
}

export interface PageSnapshot {
	url: string;
	title: string;
	bodyText: string;
	inputs: Array<{ id: string; name: string; type: string; selector: string }>;
	buttons: string[];
	links: Array<{ text: string; href: string }>;
	/** Accessibility tree as formatted string, only populated when snapshot: "accessibility" is requested. */
	accessibilityTree?: string;
}

export interface TabEvaluateResult {
	result: unknown;
	page: PageSnapshot;
	pageState: "ready" | "navigating";
}

export interface CookieEntry {
	name: string;
	value: string;
	domain: string;
	path: string;
	httpOnly: boolean;
	secure: boolean;
}

export interface SessionExport {
	origin: string;
	curlCookie: string;
	headers: Record<string, string>;
	raw: {
		cookies: CookieEntry[];
		localStorage: Record<string, string>;
	};
}

export interface CloseTabInfo {
	title: string;
	url: string;
	remainingCount: number;
}

interface PendingCommand {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

interface TabConnection {
	ws: WebSocket;
	pending: Map<number, PendingCommand>;
	eventHandlers: Map<string, Array<(params?: unknown) => void>>;
	nextId: number;
	navigating: boolean;
	tabId: string;
}

// ---- Module-level state ----

let activeEndpoint: string | null = null;
let discoveredTabs: CdpTab[] = [];
let activeTabId: string | null = null;
/** Map: tab ID → WebSocket debug URL (from /json) */
const tabDebugUrls: Map<string, string> = new Map();
/** Map: tab ID → active connection */
const tabConnections: Map<string, TabConnection> = new Map();

// ---- Public API (called by tools) ----

export function getActiveEndpoint(): string | null {
	return activeEndpoint;
}

export function getDiscoveredTabs(): CdpTab[] {
	return discoveredTabs;
}

export function getActiveTabId(): string | null {
	return activeTabId;
}

/**
 * Connect to a Chrome CDP endpoint, discover open tabs.
 */
export async function connectCdp(endpoint: string, signal?: AbortSignal): Promise<CdpTab[]> {
	const url = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
	const jsonUrl = `${url}/json`;

	const response = await fetch(jsonUrl, {
		signal: signal ?? undefined,
	});

	if (!response.ok) {
		throw new Error(
			`Cannot connect to CDP endpoint at ${endpoint}: HTTP ${response.status}. Is Chrome running with --remote-debugging-port?`,
		);
	}

	const raw: Array<{
		id: string;
		url: string;
		title: string;
		webSocketDebuggerUrl: string;
		type: string;
	}> = await response.json();

	const pageTabs = raw.filter((t) => t.type === "page");

	// Close any previous connections BEFORE populating new state
	disconnectCdp();

	const tabs: CdpTab[] = pageTabs.map((t) => ({
		id: t.id,
		url: t.url,
		title: t.title || "",
	}));

	// Store debug URLs
	for (const t of pageTabs) {
		tabDebugUrls.set(t.id, t.webSocketDebuggerUrl);
	}

	activeEndpoint = endpoint;
	discoveredTabs = tabs;
	activeTabId = discoveredTabs.length > 0 ? discoveredTabs[0].id : null;

	return discoveredTabs;
}

/**
 * Disconnect from the current CDP endpoint, closing all WebSocket connections.
 */
export function disconnectCdp(): void {
	for (const conn of tabConnections.values()) {
		try {
			conn.ws.close();
		} catch {
			// Ignore close errors
		}
	}
	tabConnections.clear();
	tabDebugUrls.clear();
	activeEndpoint = null;
	discoveredTabs = [];
	activeTabId = null;
}

/**
 * Resolve a tab specification to a tab ID.
 * spec.tabIndex — 1-based index from browser_connect listing
 * spec.tabName — substring match on title
 * spec.tabUrl — substring match on URL
 * spec.tabId — exact match on ID
 * If no spec is given, returns the active tab.
 */
export function resolveTab(spec?: { tabIndex?: number; tabName?: string; tabUrl?: string; tabId?: string }): CdpTab {
	if (!spec || (spec.tabIndex === undefined && !spec.tabName && !spec.tabUrl && !spec.tabId)) {
		if (activeTabId) {
			const tab = discoveredTabs.find((t) => t.id === activeTabId);
			if (tab) return tab;
		}
		throw new Error("No active tab. Use browser_connect first, or specify a tab by name, URL, or ID.");
	}

	if (spec.tabIndex !== undefined) {
		const idx = spec.tabIndex - 1; // convert from 1-based to 0-based
		if (idx < 0 || idx >= discoveredTabs.length) {
			throw new Error(`Tab index ${spec.tabIndex} is out of range. Available tabs: 1–${discoveredTabs.length}.`);
		}
		return discoveredTabs[idx];
	}

	if (spec.tabId) {
		const tab = discoveredTabs.find((t) => t.id === spec.tabId);
		if (!tab) throw new Error(`Tab with ID "${spec.tabId}" not found.`);
		return tab;
	}

	if (spec.tabUrl) {
		const searchUrl = spec.tabUrl;
		const matches = discoveredTabs.filter((t) => t.url.includes(searchUrl));
		if (matches.length === 0) {
			throw new Error(
				`No tab found with URL containing "${searchUrl}". Available tabs: ${discoveredTabs.map((t) => `${t.title} (${t.url})`).join(", ")}`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`Multiple tabs match URL "${searchUrl}": ${matches.map((t) => `${t.title} (${t.id})`).join(", ")}. Please be more specific.`,
			);
		}
		return matches[0];
	}

	if (spec.tabName) {
		const searchName = spec.tabName;
		const matches = discoveredTabs.filter((t) => t.title.toLowerCase().includes(searchName.toLowerCase()));
		if (matches.length === 0) {
			throw new Error(
				`No tab found with title containing "${searchName}". Available tabs: ${discoveredTabs.map((t) => t.title || "(untitled)").join(", ")}`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`Multiple tabs match "${searchName}": ${matches.map((t) => `${t.title} (${t.id})`).join(", ")}. Please be more specific.`,
			);
		}
		return matches[0];
	}

	throw new Error("Could not resolve tab.");
}

/**
 * Parse the tab parameter from tool arguments into a resolveTab spec.
 * Handles:
 *   - Numeric strings ("3") → tabIndex
 *   - Strings with "." and no spaces ("portal.example.com") → tabUrl
 *   - Other strings ("News") → tabName
 *   - Numbers (3) → tabIndex
 *   - undefined/null → active tab
 */
export function parseTabSpec(tab: unknown): { tabIndex?: number; tabName?: string; tabUrl?: string } | undefined {
	if (tab === undefined || tab === null) return undefined;

	// Number or numeric string → index
	if (typeof tab === "number") {
		return { tabIndex: tab };
	}
	if (typeof tab === "string" && /^\d+$/.test(tab)) {
		return { tabIndex: Number.parseInt(tab, 10) };
	}

	const tabStr = String(tab);

	// Contains "." and no spaces → URL match
	if (tabStr.includes(".") && !tabStr.includes(" ")) {
		return { tabUrl: tabStr };
	}

	// Otherwise → title match
	return { tabName: tabStr };
}

/**
 * Navigate a tab (or create a new one) to a URL. Waits for page load.
 * Returns the tab ID and initial snapshot.
 *
 * When reuseTab is true, navigates the active tab using Page.navigate instead of creating a new tab.
 */
export async function navigateCdp(
	url: string,
	signal?: AbortSignal,
	reuseTab?: boolean,
): Promise<{ tabId: string; snapshot: PageSnapshot }> {
	if (!activeEndpoint) {
		throw new Error("No CDP connection. Use browser_connect first.");
	}

	// Reuse active tab via Page.navigate
	if (reuseTab) {
		if (!activeTabId) {
			throw new Error("No active tab to reuse. Use browser_connect first or open a tab with browser_navigate.");
		}

		const conn = await getOrCreateConnection(activeTabId, signal);

		// Navigate the existing tab
		await sendCommand(conn, "Page.navigate", { url });

		// Wait for the new page to load
		conn.navigating = true;
		await waitForLoadEvent(conn, signal);

		// Take snapshot
		const snapshot = await takeSnapshot(conn);

		// Update the discovered tab entry with the real URL
		const tabIndex = discoveredTabs.findIndex((t) => t.id === activeTabId);
		if (tabIndex >= 0 && snapshot.url) {
			discoveredTabs[tabIndex] = {
				...discoveredTabs[tabIndex],
				url: snapshot.url,
				title: snapshot.title || discoveredTabs[tabIndex].title,
			};
		}

		return { tabId: activeTabId, snapshot };
	}

	// Create a new target (tab) via PUT /json/new?{url}
	const httpUrl = activeEndpoint.includes("://") ? activeEndpoint : `http://${activeEndpoint}`;
	const putResponse = await fetch(`${httpUrl}/json/new?${encodeURIComponent(url)}`, {
		method: "PUT",
		signal: signal ?? undefined,
	});

	if (!putResponse.ok) {
		throw new Error(`Failed to create new tab: HTTP ${putResponse.status}`);
	}

	const newTab: {
		id: string;
		url: string;
		title: string;
		webSocketDebuggerUrl: string;
		type: string;
	} = await putResponse.json();

	const tabId = newTab.id;
	tabDebugUrls.set(tabId, newTab.webSocketDebuggerUrl);

	// Add to discovered tabs
	const cdpTab: CdpTab = {
		id: tabId,
		url: newTab.url || url,
		title: newTab.title || "",
	};
	discoveredTabs.push(cdpTab);

	// Connect and wait for load
	const conn = await getOrCreateConnection(tabId, signal);

	// Wait for the real page load. Chrome creates tabs at about:blank first,
	// then navigates to the target URL — the first load event may be for about:blank.
	await waitForLoadEvent(conn, signal);

	// If we landed on about:blank, the real navigation hasn't happened yet.
	// Wait for another load event.
	let loadAttempts = 0;
	while (loadAttempts < 5) {
		const urlCheck = await sendCommand(conn, "Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		});
		const currentUrl = (urlCheck as { result?: { value?: string } }).result?.value ?? "";
		if (currentUrl && currentUrl !== "about:blank") break;
		loadAttempts++;
		conn.navigating = true;
		await waitForLoadEvent(conn, signal);
	}

	// Take snapshot
	const snapshot = await takeSnapshot(conn);

	// Update the discovered tab entry with the real URL from the snapshot
	const tabIndex = discoveredTabs.findIndex((t) => t.id === tabId);
	if (tabIndex >= 0 && snapshot.url) {
		discoveredTabs[tabIndex] = {
			...discoveredTabs[tabIndex],
			url: snapshot.url,
			title: snapshot.title || discoveredTabs[tabIndex].title,
		};
	}

	activeTabId = tabId;
	return { tabId, snapshot };
}

/**
 * Evaluate JavaScript in a tab. Returns the result and a page snapshot.
 * Auto-waits for page load if the tab is navigating.
 *
 * Options:
 *   snapshot: "elements" (default) — lightweight inputs/buttons/links only
 *   snapshot: "accessibility" — also includes the accessibility tree
 */
export async function evaluateCdp(
	tabSpec: { tabName?: string; tabUrl?: string; tabId?: string } | undefined,
	expression: string,
	signal?: AbortSignal,
	options?: { snapshot?: "elements" | "accessibility" },
): Promise<TabEvaluateResult> {
	const tab = resolveTab(tabSpec);
	const conn = await getOrCreateConnection(tab.id, signal);

	// Auto-wait if the tab is navigating
	if (conn.navigating) {
		await waitForLoadEvent(conn, signal);
	}

	// Execute the user's expression
	const wrappedExpression = `(async () => { ${expression} })()`;
	const cmdResult = await sendCommand(conn, "Runtime.evaluate", {
		expression: wrappedExpression,
		returnByValue: true,
		awaitPromise: true,
	});

	const evalResult = cmdResult as {
		result?: { value?: unknown; type?: string };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	};

	if (evalResult.exceptionDetails) {
		const errText =
			evalResult.exceptionDetails.text ?? evalResult.exceptionDetails.exception?.description ?? "Unknown script error";
		throw new Error(`Script error: ${errText}`);
	}

	// Small settle delay to let the DOM update after mutations (clicks, form submits, etc.)
	if (!signal?.aborted) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 300);
			if (signal) {
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	// Take page snapshot (may fail if the expression closed the tab)
	let snapshot: PageSnapshot;
	let tabStillAlive = true;
	try {
		snapshot = await takeSnapshot(conn, options?.snapshot === "accessibility");
	} catch {
		// Tab was likely closed by the expression (e.g. window.close())
		snapshot = { url: "", title: "", bodyText: "", inputs: [], buttons: [], links: [] };
		tabStillAlive = false;
	}

	// Double-check tab liveness
	if (tabStillAlive) {
		tabStillAlive = await isTabAlive(conn);
	}

	if (!tabStillAlive) {
		removeTab(tab.id);
		activeTabId = discoveredTabs.length > 0 ? discoveredTabs[0].id : null;
	} else {
		activeTabId = tab.id;
	}

	return {
		result: evalResult.result?.value,
		page: snapshot,
		pageState: tabStillAlive ? (conn.navigating ? "navigating" : "ready") : "closed",
	};
}

/**
 * Extract session data (cookies + localStorage) from a tab.
 */
export async function exportSessionCdp(
	tabSpec: { tabName?: string; tabUrl?: string; tabId?: string } | undefined,
	signal?: AbortSignal,
): Promise<SessionExport> {
	const tab = resolveTab(tabSpec);
	const conn = await getOrCreateConnection(tab.id, signal);

	// Get the tab's current URL to determine origin
	const urlResult = await sendCommand(conn, "Runtime.evaluate", {
		expression: "location.href",
		returnByValue: true,
	});
	const pageUrl = (urlResult as { result?: { value?: string } }).result?.value ?? tab.url;
	const origin = new URL(pageUrl).origin;

	// Get all cookies via CDP
	const cookiesResult = await sendCommand(conn, "Network.getCookies", {
		urls: [pageUrl],
	});
	const cookies: CookieEntry[] = ((cookiesResult as { cookies?: Array<Record<string, unknown>> }).cookies ?? []).map((c) => ({
		name: String(c.name ?? ""),
		value: String(c.value ?? ""),
		domain: String(c.domain ?? ""),
		path: String(c.path ?? "/"),
		httpOnly: Boolean(c.httpOnly),
		secure: Boolean(c.secure),
	}));

	// Get localStorage
	const lsResult = await sendCommand(conn, "Runtime.evaluate", {
		expression: "JSON.stringify(localStorage)",
		returnByValue: true,
	});
	let localStorage: Record<string, string> = {};
	try {
		const raw = (lsResult as { result?: { value?: string } }).result?.value;
		if (typeof raw === "string") {
			localStorage = JSON.parse(raw);
		}
	} catch {
		localStorage = {};
	}

	// Build curl-compatible cookie string and headers
	const curlCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
	const headers: Record<string, string> = {};
	if (cookies.length > 0) {
		headers.Cookie = curlCookie;
	}
	// Include auth token from localStorage if present
	const authToken =
		localStorage.auth_token ??
		localStorage.authToken ??
		localStorage.token ??
		localStorage.access_token ??
		localStorage.accessToken;
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}

	activeTabId = tab.id;

	return {
		origin,
		curlCookie,
		headers,
		raw: { cookies, localStorage },
	};
}

/**
 * Close a browser tab via HTTP /json/close/{id} endpoint.
 * Removes the tab from the discovered list and updates the active tab if needed.
 */
export async function closeTabCdp(
	tabSpec: { tabName?: string; tabUrl?: string; tabId?: string } | undefined,
	signal?: AbortSignal,
): Promise<CloseTabInfo> {
	if (!activeEndpoint) {
		throw new Error("No CDP connection. Use browser_connect first.");
	}

	const tab = resolveTab(tabSpec);

	// Safety: never close the Bob AI tab — it would kill the session
	if (tab.url.includes("/bobai/")) {
		throw new Error("Cannot close the Bob AI tab — it would end this session.");
	}

	// Close the WebSocket connection first
	const conn = tabConnections.get(tab.id);
	if (conn) {
		try {
			conn.ws.close();
		} catch {
			/* ignore */
		}
		tabConnections.delete(tab.id);
	}

	// Close the tab via HTTP endpoint
	const httpBase = activeEndpoint.includes("://") ? activeEndpoint : `http://${activeEndpoint}`;
	const closeResponse = await fetch(`${httpBase}/json/close/${tab.id}`, {
		signal: signal ?? undefined,
	});

	if (!closeResponse.ok) {
		throw new Error(`Failed to close tab: HTTP ${closeResponse.status}`);
	}

	// Remove from discovered tabs
	const title = tab.title;
	const url = tab.url;
	discoveredTabs = discoveredTabs.filter((t) => t.id !== tab.id);
	tabDebugUrls.delete(tab.id);

	// Reset active tab if the closed tab was active
	if (activeTabId === tab.id) {
		activeTabId = discoveredTabs.length > 0 ? discoveredTabs[0].id : null;
	}

	return {
		title: title || "(untitled)",
		url: url || "about:blank",
		remainingCount: discoveredTabs.length,
	};
}

// ---- Internal helpers ----

async function getOrCreateConnection(tabId: string, signal?: AbortSignal): Promise<TabConnection> {
	const existing = tabConnections.get(tabId);
	if (existing) return existing;

	const debugUrl = tabDebugUrls.get(tabId);
	if (!debugUrl) {
		throw new Error(`No debug URL for tab "${tabId}". Run browser_connect first.`);
	}

	return createConnection(tabId, debugUrl, signal);
}

function createConnection(tabId: string, wsUrl: string, signal?: AbortSignal): Promise<TabConnection> {
	return new Promise<TabConnection>((resolve, reject) => {
		const ws = new WebSocket(wsUrl);

		const conn: TabConnection = {
			ws,
			pending: new Map(),
			eventHandlers: new Map(),
			nextId: 1,
			navigating: false,
			tabId,
		};

		// Abort handling
		if (signal) {
			const onAbort = () => {
				try {
					ws.close();
				} catch {
					// ignore
				}
				reject(new Error("Aborted"));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		ws.onopen = () => {
			// Enable required CDP domains
			sendCommand(conn, "Page.enable")
				.then(() => sendCommand(conn, "Runtime.enable"))
				.then(() => sendCommand(conn, "Network.enable"))
				.then(() => {
					tabConnections.set(tabId, conn);
					resolve(conn);
				})
				.catch((err) => {
					reject(err);
				});
		};

		ws.onmessage = (event: { data: string }) => {
			let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
			try {
				msg = JSON.parse(event.data as string);
			} catch {
				return;
			}

			if (msg.id !== undefined) {
				// Response to a command
				const pending = conn.pending.get(msg.id);
				if (pending) {
					conn.pending.delete(msg.id);
					if (msg.error) {
						pending.reject(new Error(msg.error.message ?? "CDP error"));
					} else {
						pending.resolve(msg.result);
					}
				}
			} else if (msg.method) {
				// Event
				const handlers = conn.eventHandlers.get(msg.method);
				if (handlers) {
					for (const handler of handlers) {
						try {
							handler(msg.params);
						} catch {
							// Ignore handler errors
						}
					}
				}

				// Track navigation state
				if (msg.method === "Page.frameNavigated") {
					// Check if it's the main frame
					const params = msg.params as { frame?: { parentId?: string } } | undefined;
					if (!params?.frame?.parentId) {
						conn.navigating = true;
					}
				}
				if (msg.method === "Page.loadEventFired") {
					conn.navigating = false;
				}
				// Navigation within document (SPA hash changes, pushState)
				if (msg.method === "Page.navigatedWithinDocument") {
					conn.navigating = true;
					// Resolve quickly for SPA navigations (no full page load)
					setTimeout(() => {
						conn.navigating = false;
					}, 2000);
				}
			}
		};

		ws.onerror = () => {
			reject(new Error("WebSocket connection error"));
		};

		ws.onclose = () => {
			tabConnections.delete(tabId);
			// Reject all pending commands
			for (const pending of conn.pending.values()) {
				pending.reject(new Error("WebSocket connection closed"));
			}
			conn.pending.clear();
		};
	});
}

async function sendCommand(
	conn: TabConnection,
	method: string,
	params?: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<unknown> {
	const id = conn.nextId++;
	return new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(() => {
			conn.pending.delete(id);
			reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		conn.pending.set(id, {
			resolve: (value: unknown) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: (reason: Error) => {
				clearTimeout(timer);
				reject(reason);
			},
		});
		try {
			conn.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
		} catch (sendErr) {
			clearTimeout(timer);
			conn.pending.delete(id);
			reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
		}
	});
}

async function waitForLoadEvent(conn: TabConnection, signal?: AbortSignal, timeoutMs = 30000): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Timeout waiting for page load (${timeoutMs}ms)`));
		}, timeoutMs);

		function handler() {
			clearTimeout(timer);
			resolve();
		}

		// If already loaded, resolve immediately
		if (!conn.navigating) {
			clearTimeout(timer);
			resolve();
			return;
		}

		// Listen for load event
		const handlers = conn.eventHandlers.get("Page.loadEventFired") ?? [];
		handlers.push(handler);
		conn.eventHandlers.set("Page.loadEventFired", handlers);

		// Cleanup on abort
		if (signal) {
			const onAbort = () => {
				clearTimeout(timer);
				const h = conn.eventHandlers.get("Page.loadEventFired");
				if (h) {
					const idx = h.indexOf(handler);
					if (idx >= 0) h.splice(idx, 1);
				}
				reject(new Error("Aborted"));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

async function takeSnapshot(conn: TabConnection, includeAccessibility = false): Promise<PageSnapshot> {
	let snapshot: PageSnapshot = {
		url: "",
		title: "",
		bodyText: "",
		inputs: [],
		buttons: [],
		links: [],
	};

	try {
		const result = await sendCommand(conn, "Runtime.evaluate", {
			expression: SNAPSHOT_SCRIPT,
			returnByValue: true,
		});

		const value = (result as { result?: { value?: string } }).result?.value;
		if (typeof value === "string") {
			const parsed = JSON.parse(value);
			snapshot = {
				url: parsed.url || "",
				title: parsed.title || "",
				bodyText: parsed.bodyText || "",
				inputs: parsed.inputs || [],
				buttons: parsed.buttons || [],
				links: parsed.links || [],
			};
		}
	} catch {
		// Snapshot failed — return empty
	}

	// Optionally fetch the accessibility tree
	if (includeAccessibility) {
		try {
			const axResult = await sendCommand(conn, "Accessibility.getFullAXTree", {});
			const nodes = (axResult as { nodes?: Array<Record<string, unknown>> }).nodes ?? [];
			snapshot.accessibilityTree = formatAccessibilityTree(nodes);
		} catch {
			snapshot.accessibilityTree = "(failed to fetch accessibility tree)";
		}
	}

	return snapshot;
}

/**
 * Check if a tab is still alive by sending a lightweight ping.
 */
async function isTabAlive(conn: TabConnection): Promise<boolean> {
	try {
		await sendCommand(conn, "Runtime.evaluate", {
			expression: "1",
			returnByValue: true,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Format the CDP accessibility tree nodes into a readable hierarchy.
 * Each line is indented by depth and shows [role] "name".
 */
function formatAccessibilityTree(nodes: Array<Record<string, unknown>>): string {
	if (nodes.length === 0) return "(empty accessibility tree)";

	const lines: string[] = [];
	// Build a node lookup by nodeId
	const nodeMap = new Map<string, Record<string, unknown>>();
	for (const node of nodes) {
		nodeMap.set(String(node.nodeId), node);
	}

	// Track visited nodes to avoid loops
	const visited = new Set<string>();
	// Track parent-child relationships: childId -> parentId
	const parentMap = new Map<string, string>();
	for (const node of nodes) {
		const children = node.children as Array<{ nodeId: string }> | undefined;
		if (children) {
			for (const child of children) {
				parentMap.set(String(child.nodeId), String(node.nodeId));
			}
		}
	}

	// Find root nodes (nodes without parents)
	const rootNodes = nodes.filter((n) => {
		const id = String(n.nodeId);
		return !parentMap.has(id);
	});

	function renderNode(node: Record<string, unknown>, depth: number): void {
		const nodeId = String(node.nodeId);
		if (visited.has(nodeId)) return;
		visited.add(nodeId);

		if (node.ignored) {
			// Render children of ignored nodes at the same depth
			const children = node.children as Array<{ nodeId: string }> | undefined;
			if (children) {
				for (const child of children) {
					const childNode = nodeMap.get(String(child.nodeId));
					if (childNode) renderNode(childNode, depth);
				}
			}
			return;
		}

		const role = (node.role as { value?: string } | undefined)?.value ?? "unknown";
		const name = (node.name as { value?: string } | undefined)?.value ?? "";
		const indent = "  ".repeat(Math.min(depth, 10));
		const nameStr = name ? ` "${name}"` : "";

		lines.push(`${indent}[${role}]${nameStr}`);

		const children = node.children as Array<{ nodeId: string }> | undefined;
		if (children) {
			for (const child of children) {
				const childNode = nodeMap.get(String(child.nodeId));
				if (childNode) renderNode(childNode, depth + 1);
			}
		}
	}

	for (const root of rootNodes) {
		renderNode(root, 0);
	}

	return lines.join("\n");
}

/**
 * Remove a tab from the discovered list and debug URL map.
 */
function removeTab(tabId: string): void {
	discoveredTabs = discoveredTabs.filter((t) => t.id !== tabId);
	tabDebugUrls.delete(tabId);
	tabConnections.delete(tabId);
}
