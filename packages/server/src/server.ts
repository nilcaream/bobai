import type { Database } from "bun:sqlite";
import path from "node:path";
import { type CommandRequest, handleCommand } from "./command";
import { compactToBudget } from "./compaction/compact-to-budget";
import { EVICTION_DISTANCE } from "./compaction/eviction";
import { createCompactionRegistry } from "./compaction/registry";
import {
	AGE_INFLECTION,
	AGE_STEEPNESS,
	computeContextPressure,
	computeMinimumDistance,
	DEFAULT_THRESHOLD,
	MAX_AGE_DISTANCE,
	PRE_PROMPT_TARGET,
} from "./compaction/strength";
import { mapEvictedToStored } from "./compaction/view";
import { handlePrompt } from "./handler";
import { loadInstructions } from "./instructions";
import type { Logger } from "./log/logger";
import { sessionScope } from "./log/session-tag";
import { getProjectInfo } from "./project-info";
import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import { CURATED_MODELS, formatModelCost, formatModelDisplay, loadModelsConfig } from "./provider/copilot-models";
import type { AssistantMessage, Provider } from "./provider/provider";
import {
	deleteSession,
	getMessages,
	getMostRecentParentSession,
	getRecentPrompts,
	getSession,
	listSessions,
	listSubagentSessions,
} from "./session/repository";
import type { SkillRegistry } from "./skill/skill";
import { buildSystemPrompt } from "./system-prompt";
import welcomeTemplate from "./welcome.md" with { type: "text" };

export interface ServerOptions {
	port: number;
	staticDir?: string;
	db?: Database;
	provider?: Provider;
	model?: string;
	maxIterations?: number;
	projectRoot?: string;
	configDir?: string;
	skills?: SkillRegistry;
	skillDirectories?: string[];
	logger?: Logger;
	logDir?: string;
}

export function createServer(options: ServerOptions) {
	const staticDir = options.staticDir;

	// Track active AbortControllers per WebSocket for cleanup on disconnect
	const wsAbortControllers = new Map<object, AbortController>();

	// Per-session promise chain to prevent concurrent agent loops on the same session
	const sessionLocks = new Map<string, Promise<void>>();

	// Session ownership: which WebSocket owns which session
	const sessionOwners = new Map<string, object>(); // sessionId → ws
	const wsOwnedSessions = new Map<object, string>(); // ws → sessionId (reverse lookup)

	function releaseOwnership(ws: object) {
		const ownedSessionId = wsOwnedSessions.get(ws);
		if (ownedSessionId) {
			wsOwnedSessions.delete(ws);
			if (sessionOwners.get(ownedSessionId) === ws) {
				sessionOwners.delete(ownedSessionId);
			}
		}
	}

	return Bun.serve({
		port: options.port,
		async fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/bobai/ws") {
				const upgraded = server.upgrade(req);
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bobai/health") {
				return Response.json({ status: "ok" });
			}

			if (url.pathname === "/bobai/project-info") {
				const info = await getProjectInfo(options.projectRoot ?? process.cwd());
				return Response.json(info);
			}

			if (url.pathname === "/bobai/welcome") {
				const vars: Record<string, string> = {
					__revision__: process.env.BOBAI_BUILD_REV ?? "dev",
					__date__: process.env.BOBAI_BUILD_DATE ?? "",
					__directory__: options.projectRoot ?? process.cwd(),
				};
				const markdown = welcomeTemplate.replace(/__\w+__/g, (m) => vars[m] ?? m);
				return Response.json({ markdown });
			}

			// GET /bobai/skills — list available skills
			if (url.pathname === "/bobai/skills") {
				const skillList = options.skills?.list() ?? [];
				return Response.json(skillList.map((s) => ({ name: s.name, description: s.description })));
			}

			// POST /bobai/skill — get skill content by name
			if (url.pathname === "/bobai/skill" && req.method === "POST") {
				const body = (await req.json()) as { name: string };
				const skill = options.skills?.get(body.name);
				if (!skill) {
					return new Response("Skill not found", { status: 404 });
				}
				return Response.json({ name: skill.name, description: skill.description, content: skill.content });
			}

			if (url.pathname === "/bobai/prompts/recent") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const limitParam = Number(url.searchParams.get("limit") ?? 10);
				const limit = Math.min(Math.max(1, Number.isFinite(limitParam) ? limitParam : 10), 50);
				const prompts = getRecentPrompts(options.db, limit);
				return Response.json(prompts);
			}

			// Context endpoint: GET /bobai/session/:id/context[?compacted=true]
			const contextMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/context$/);
			if (contextMatch) {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessionId = decodeURIComponent(contextMatch[1]);
				const storedMessages = getMessages(options.db, sessionId);

				// Build a fresh system prompt with current skills and instructions
				const skills = options.skills ?? { list: () => [], get: () => undefined };
				const instructions = loadInstructions(options.configDir ?? "", options.projectRoot ?? process.cwd());
				const systemPrompt = buildSystemPrompt(skills.list(), instructions);

				// BACKWARD COMPAT: Sessions created before the dynamic system prompt change
				// stored the system message in the DB at sort_order 0. Strip it — we always
				// prepend a fresh one below. Remove this filter once all legacy sessions are gone.
				const conversationMessages = storedMessages.filter((m) => m.role !== "system");

				if (url.searchParams.get("compacted") !== "true") {
					// Non-compacted (context) view: prepend dynamic system prompt as a synthetic StoredMessage
					const systemMessage = {
						id: "system-dynamic",
						sessionId,
						role: "system" as const,
						content: systemPrompt,
						createdAt: new Date().toISOString(),
						sortOrder: -1,
						metadata: null,
					};
					return Response.json([systemMessage, ...conversationMessages]);
				}

				// Compacted view: convert to Message[], run compaction, return with stats
				const session = getSession(options.db, sessionId);
				const storedPromptTokens = session?.promptTokens ?? 0;
				const storedPromptChars = session?.promptChars ?? 0;
				const modelId = session?.model ?? options.model ?? "";
				const modelConfigs = loadModelsConfig();
				const modelConfig = modelConfigs.find((m) => m.id === modelId);
				const contextWindow = modelConfig?.contextWindow ?? 0;
				if (contextWindow <= 0) {
					options.logger
						?.withScope(sessionScope(sessionId))
						.warn("CONFIG", `No contextWindow for model "${modelId}"; compacted context view unavailable`);
				}

				const messages = [
					{ role: "system" as const, content: systemPrompt },
					...conversationMessages.map((m) => {
						if (m.role === "tool" && m.metadata?.tool_call_id) {
							return { role: "tool" as const, content: m.content, tool_call_id: m.metadata.tool_call_id as string };
						}
						if (m.role === "assistant" && m.metadata?.tool_calls) {
							return {
								role: "assistant" as const,
								content: m.content || null,
								tool_calls: m.metadata.tool_calls as AssistantMessage["tool_calls"],
							};
						}
						return { role: m.role as "user" | "assistant", content: m.content };
					}),
				];

				if (contextWindow <= 0 || (storedPromptTokens <= 0 && storedPromptChars <= 0)) {
					// No pressure data — return the dynamic system prompt + conversation messages as-is
					const systemMessage = {
						id: "system-dynamic",
						sessionId,
						role: "system" as const,
						content: systemPrompt,
						createdAt: new Date().toISOString(),
						sortOrder: -1,
						metadata: null,
					};
					return Response.json({
						messages: [systemMessage, ...conversationMessages],
						stats: null,
						details: null,
						reason: "no context pressure data",
					});
				}

				const tools = createCompactionRegistry();
				const compactionResult = compactToBudget({
					messages,
					contextWindow,
					promptTokens: storedPromptTokens,
					promptChars: storedPromptChars,
					target: PRE_PROMPT_TARGET,
					type: "pre-prompt",
					tools,
					sessionId,
				});

				// mapEvictedToStored uses the pre-eviction array (compacted, same
				// length as original) to build index-based identity map, and iterates
				// the post-eviction array (messages) to produce the final output.
				const compactedStored = mapEvictedToStored(
					compactionResult.compacted,
					compactionResult.messages,
					conversationMessages,
					sessionId,
				);

				const charsPerToken = compactionResult.charsPerToken;
				const estimatedContextNeeded = charsPerToken > 0 ? compactionResult.charsBefore / (contextWindow * charsPerToken) : 0;

				// Count messages by role before and after compaction+eviction
				function countByRole(msgs: { role: string }[]): Record<string, number> {
					const counts: Record<string, number> = {};
					for (const m of msgs) {
						counts[m.role] = (counts[m.role] ?? 0) + 1;
					}
					counts.total = msgs.length;
					return counts;
				}

				// Compute compaction reach for each tool at current usage
				const pressure = computeContextPressure(compactionResult.usage);
				const toolReach: Array<{
					name: string;
					type: "output" | "arguments";
					threshold: number;
					minimumDistance: number;
					compactedFrom: number | null;
				}> = [];
				for (const def of tools.definitions) {
					const toolName = def.function.name;
					const tool = tools.get(toolName);
					if (!tool) continue;
					if (tool.outputThreshold !== undefined) {
						const dist = computeMinimumDistance(pressure, tool.outputThreshold, messages.length);
						toolReach.push({
							name: toolName,
							type: "output",
							threshold: tool.outputThreshold,
							minimumDistance: dist,
							compactedFrom: dist > 0 ? messages.length - dist : null,
						});
					}
					if (tool.argsThreshold !== undefined) {
						const dist = computeMinimumDistance(pressure, tool.argsThreshold, messages.length);
						toolReach.push({
							name: toolName,
							type: "arguments",
							threshold: tool.argsThreshold,
							minimumDistance: dist,
							compactedFrom: dist > 0 ? messages.length - dist : null,
						});
					}
				}
				// Add excluded roles
				for (const role of ["user", "assistant", "system"]) {
					toolReach.push({ name: role, type: "output", threshold: -1, minimumDistance: -1, compactedFrom: null });
				}
				// Sort by compaction resistance: smallest minimum distance first, excluded/never last
				toolReach.sort((a, b) => {
					if (a.minimumDistance === -1 && b.minimumDistance === -1) return 0;
					if (a.minimumDistance === -1) return 1;
					if (b.minimumDistance === -1) return -1;
					return a.minimumDistance - b.minimumDistance;
				});

				return Response.json({
					messages: compactedStored.map((m) => ({ ...m, messageIndex: m.originalIndex })),
					stats: {
						usage: compactionResult.usage,
						iterations: compactionResult.iterations,
						charsBefore: compactionResult.charsBefore,
						charsAfter: compactionResult.charsAfter,
						charBudget: compactionResult.charBudget,
						charsPerToken: compactionResult.charsPerToken,
						type: "pre-prompt",
						parameters: {
							threshold: DEFAULT_THRESHOLD,
							inflection: AGE_INFLECTION,
							steepness: AGE_STEEPNESS,
							maxAgeDistance: MAX_AGE_DISTANCE,
							evictionDistance: EVICTION_DISTANCE,
						},
						estimatedContextNeeded,
						target: PRE_PROMPT_TARGET,
						elapsedMs: compactionResult.elapsedMs,
						messagesBefore: countByRole(messages),
						messagesAfter: countByRole(compactionResult.messages),
						toolReach,
					},
					details: Object.fromEntries(compactionResult.details),
				});
			}

			if (url.pathname === "/bobai/models") {
				const models = CURATED_MODELS.map((id, i) => ({
					index: i + 1,
					id,
					cost: formatModelCost(id),
				}));
				const defaultModel = options.model ?? "gpt-5-mini";
				const defaultStatus = formatModelDisplay(defaultModel, 0, options.configDir);
				return Response.json({ models, defaultModel, defaultStatus });
			}

			if (url.pathname === "/bobai/command" && req.method === "POST") {
				if (!options.db) {
					return Response.json({ ok: false, error: "Database not available" });
				}
				const body = (await req.json()) as CommandRequest;
				const result = handleCommand(options.db, body, options.configDir);
				return Response.json(result);
			}

			if (url.pathname === "/bobai/subagents") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const parentId = url.searchParams.get("parentId");
				if (!parentId) {
					return Response.json({ error: "parentId is required" }, { status: 400 });
				}
				const subagents = listSubagentSessions(options.db, parentId);
				const body = subagents.map((s, i) => ({
					index: i + 1,
					title: s.title ?? "(untitled)",
					sessionId: s.id,
				}));
				return Response.json(body);
			}

			// GET /bobai/sessions/recent — most recently updated parent session
			if (url.pathname === "/bobai/sessions/recent") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const session = getMostRecentParentSession(options.db);
				if (!session) return Response.json(null);
				const status = session.model ? formatModelDisplay(session.model, session.promptTokens, options.configDir) : null;
				return Response.json({ id: session.id, title: session.title, model: session.model, status });
			}

			// GET /bobai/sessions — list parent sessions
			if (url.pathname === "/bobai/sessions") {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessions = listSessions(options.db);
				const body = sessions.map((s, i) => ({
					index: i + 1,
					id: s.id,
					title: s.title,
					updatedAt: s.updatedAt,
					owned: sessionOwners.has(s.id),
				}));
				return Response.json(body);
			}

			// GET /bobai/session/:id/load — session metadata + messages
			const loadMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/load$/);
			if (loadMatch) {
				if (!options.db) {
					return new Response("Database not available", { status: 503 });
				}
				const sessionId = decodeURIComponent(loadMatch[1]);
				const session = getSession(options.db, sessionId);
				if (!session) {
					return new Response("Session not found", { status: 404 });
				}
				const messages = getMessages(options.db, sessionId)
					// BACKWARD COMPAT: Strip legacy stored system messages from old sessions.
					// The system prompt is now dynamic, not persisted. Remove this filter
					// once all legacy sessions are gone.
					.filter((m) => m.role !== "system");
				const status = session.model ? formatModelDisplay(session.model, session.promptTokens, options.configDir) : null;
				return Response.json({
					session: { id: session.id, title: session.title, model: session.model, parentId: session.parentId },
					messages,
					status,
				});
			}

			// GET /bobai/session/:id/ownership — check if session is owned
			const ownershipMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)\/ownership$/);
			if (ownershipMatch) {
				const sid = decodeURIComponent(ownershipMatch[1]);
				return Response.json({ owned: sessionOwners.has(sid) });
			}

			// DELETE /bobai/session/:id — delete a session and its children
			const deleteMatch = url.pathname.match(/^\/bobai\/session\/([^/]+)$/);
			if (deleteMatch && req.method === "DELETE") {
				if (!options.db) {
					return Response.json({ ok: false, error: "Database not available" });
				}
				const sid = decodeURIComponent(deleteMatch[1]);
				const session = getSession(options.db, sid);
				if (!session) {
					return Response.json({ ok: false, error: "Session not found" });
				}
				// Block deletion if another tab owns this session
				const owner = sessionOwners.get(sid);
				if (owner) {
					return Response.json({ ok: false, error: "Session is active in another tab" });
				}
				deleteSession(options.db, sid);
				return Response.json({ ok: true, id: sid, title: session.title });
			}

			if (staticDir && url.pathname.startsWith("/bobai")) {
				const relative = url.pathname.replace(/^\/bobai\/?/, "");
				const filePath = path.join(staticDir, relative || "index.html");
				const file = Bun.file(filePath);
				return file.exists().then((exists) => {
					if (exists) return new Response(file);
					// SPA fallback: serve index.html for any unmatched /bobai/* path
					return new Response(Bun.file(path.join(staticDir, "index.html")));
				});
			}

			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				let msg: ClientMessage;
				try {
					msg = JSON.parse(raw as string) as ClientMessage;
				} catch {
					send(ws, { type: "error", message: "Invalid JSON" });
					return;
				}

				if (msg.type === "subscribe") {
					releaseOwnership(ws); // release any previous ownership
					const currentOwner = sessionOwners.get(msg.sessionId);
					if (currentOwner && currentOwner !== ws) {
						send(ws, { type: "session_locked", sessionId: msg.sessionId });
					} else {
						sessionOwners.set(msg.sessionId, ws);
						wsOwnedSessions.set(ws, msg.sessionId);
						send(ws, { type: "session_subscribed", sessionId: msg.sessionId });
					}
					return;
				}

				if (msg.type === "unsubscribe") {
					releaseOwnership(ws);
					return;
				}

				if (msg.type === "cancel") {
					const controller = wsAbortControllers.get(ws);
					if (controller) {
						controller.abort();
					}
					return;
				}

				if (msg.type === "prompt") {
					const { db, provider, model } = options;
					if (provider && model && db) {
						// Create abort controller for this prompt — aborted on WebSocket close
						const controller = new AbortController();
						wsAbortControllers.set(ws, controller);

						const runPrompt = () =>
							handlePrompt({
								ws,
								db,
								provider,
								model,
								text: msg.text,
								sessionId: msg.sessionId,
								projectRoot: options.projectRoot ?? process.cwd(),
								configDir: options.configDir ?? "",
								skills: options.skills ?? { get: () => undefined, list: () => [] },
								skillDirectories: options.skillDirectories,
								stagedSkills: msg.stagedSkills,
								maxIterations: options.maxIterations,
								logger: options.logger,
								logDir: options.logDir,
								signal: controller.signal,
							})
								.catch((err) => {
									send(ws, { type: "error", message: "Unexpected error" });
									console.error("Unhandled error in handlePrompt:", err);
								})
								.finally(() => {
									wsAbortControllers.delete(ws);
								});

						// Session-level concurrency guard: chain onto any existing promise for this session.
						// For existing sessions this serialises prompts to prevent double-submit races.
						// New sessions (no sessionId yet) each get a unique key so they run concurrently —
						// a shared "__new__" sentinel would serialise unrelated tabs. The real session ID
						// is created inside handlePrompt, but by then the lock key is already chosen.
						const sessionKey = msg.sessionId ?? crypto.randomUUID();
						const existing = sessionLocks.get(sessionKey) ?? Promise.resolve();
						const next = existing.then(runPrompt, runPrompt);
						sessionLocks.set(sessionKey, next);
						// Clean up finished chains to avoid memory leak
						next.finally(() => {
							if (sessionLocks.get(sessionKey) === next) {
								sessionLocks.delete(sessionKey);
							}
						});
					} else {
						send(ws, { type: "error", message: "No provider configured" });
					}
					return;
				}

				send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
			},
			close(ws) {
				releaseOwnership(ws);
				const controller = wsAbortControllers.get(ws);
				if (controller) {
					controller.abort();
					wsAbortControllers.delete(ws);
				}
			},
		},
	});
}
