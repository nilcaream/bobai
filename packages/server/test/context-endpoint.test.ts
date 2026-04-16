import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { appendMessage, createSession, updateSessionModel, updateSessionPromptTokens } from "../src/session/repository";
import { createTestDb, startTestServer } from "./helpers";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(import.meta.dir, prefix));
	tempDirs.push(dir);
	return dir;
}

function writeModelsConfig(configDir: string, models: unknown): void {
	fs.writeFileSync(path.join(configDir, "copilot-models.json"), JSON.stringify(models, null, 2));
}

function addLegacySystemMessage(db: Database, sessionId: string, content: string): void {
	db.prepare(
		"INSERT INTO messages (id, session_id, role, content, created_at, sort_order, metadata) VALUES (?, ?, 'system', ?, ?, 0, NULL)",
	).run(crypto.randomUUID(), sessionId, content, new Date().toISOString());
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("context endpoint", () => {
	test("GET /bobai/session/:id/context returns 503 when db is not configured", async () => {
		const started = startTestServer({ port: 0, projectRoot: import.meta.dir, configDir: import.meta.dir });
		try {
			const res = await fetch(`${started.baseUrl}/bobai/session/test-session/context`);
			expect(res.status).toBe(503);
			expect(await res.text()).toBe("Database not available");
		} finally {
			started.server.stop(true);
		}
	});

	test("GET /bobai/session/:id/context prepends a dynamic system message and strips legacy stored system messages", async () => {
		const db = createTestDb();
		const configDir = makeTempDir("context-endpoint-config-");
		const started = startTestServer({ port: 0, db, projectRoot: import.meta.dir, configDir });
		try {
			const session = createSession(db);
			addLegacySystemMessage(db, session.id, "legacy persisted system prompt");
			appendMessage(db, session.id, "user", "hello");
			appendMessage(db, session.id, "assistant", "hi there");
			appendMessage(db, session.id, "tool", "tool output", { tool_call_id: "tc1" });

			const res = await fetch(`${started.baseUrl}/bobai/session/${session.id}/context`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{
				id: string;
				role: string;
				content: string;
				sortOrder: number;
			}>;

			expect(body).toHaveLength(4);
			expect(body[0].id).toBe("system-dynamic");
			expect(body[0].role).toBe("system");
			expect(body[0].sortOrder).toBe(-1);
			expect(body[0].content.length).toBeGreaterThan(0);
			expect(body[0].content).not.toContain("legacy persisted system prompt");
			expect(body.some((msg) => msg.content === "legacy persisted system prompt")).toBe(false);
			expect(body.slice(1).map((msg) => msg.role)).toEqual(["user", "assistant", "tool"]);
			expect(body.slice(1).map((msg) => msg.content)).toEqual(["hello", "hi there", "tool output"]);
		} finally {
			started.server.stop(true);
			db.close();
		}
	});

	test("GET /bobai/session/:id/context?compacted=true returns fallback payload when pressure data is unavailable", async () => {
		const db = createTestDb();
		const configDir = makeTempDir("context-endpoint-config-");
		const started = startTestServer({ port: 0, db, projectRoot: import.meta.dir, configDir, model: "unknown-model" });
		try {
			const session = createSession(db);
			appendMessage(db, session.id, "user", "hello");
			appendMessage(db, session.id, "assistant", "hi there");

			const res = await fetch(`${started.baseUrl}/bobai/session/${session.id}/context?compacted=true`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				messages: Array<{ id: string; role: string; sortOrder: number }>;
				stats: null;
				details: null;
				reason: string;
			};

			expect(body.reason).toBe("no context pressure data");
			expect(body.stats).toBeNull();
			expect(body.details).toBeNull();
			expect(body.messages).toHaveLength(3);
			expect(body.messages[0]).toMatchObject({ id: "system-dynamic", role: "system", sortOrder: -1 });
			expect(body.messages.slice(1).map((msg) => msg.role)).toEqual(["user", "assistant"]);
		} finally {
			started.server.stop(true);
			db.close();
		}
	});

	test("GET /bobai/session/:id/context?compacted=true returns stats, details, and normalized tool metadata when pressure data is available", async () => {
		const db = createTestDb();
		const configDir = makeTempDir("context-endpoint-config-");
		writeModelsConfig(configDir, [
			{
				id: "test-model",
				name: "Test Model",
				contextWindow: 1000,
				maxOutputTokens: 200,
				premiumRequestMultiplier: 0,
				enabled: true,
			},
		]);
		const started = startTestServer({ port: 0, db, projectRoot: import.meta.dir, configDir, model: "test-model" });
		try {
			const session = createSession(db);
			updateSessionModel(db, session.id, "test-model");
			updateSessionPromptTokens(db, session.id, 100, 400);
			appendMessage(db, session.id, "user", "please inspect the project");
			appendMessage(db, session.id, "assistant", "", {
				tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
			});
			appendMessage(db, session.id, "tool", "README.md\npackages\n", { tool_call_id: "tc1" });
			appendMessage(db, session.id, "assistant", "I found the project files.");

			const res = await fetch(`${started.baseUrl}/bobai/session/${session.id}/context?compacted=true`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				messages: Array<{
					id: string;
					role: string;
					content: string;
					messageIndex: number;
					metadata: Record<string, unknown> | null;
				}>;
				stats: {
					type: string;
					messagesBefore: { total: number };
					messagesAfter: { total: number };
					toolReach: Array<{ name: string; type: string }>;
				};
				details: Record<string, Record<string, unknown>>;
			};

			expect(body.stats.type).toBe("pre-prompt");
			expect(body.stats.messagesBefore.total).toBeGreaterThan(0);
			expect(body.stats.messagesAfter.total).toBeGreaterThan(0);
			expect(body.stats.toolReach.length).toBeGreaterThan(0);
			expect(body.stats.toolReach.some((entry) => entry.name === "bash" && entry.type === "output")).toBe(true);
			expect(Object.keys(body.details)).toContain("tc1");
			expect(typeof body.details.tc1).toBe("object");
			expect(body.messages.every((msg) => typeof msg.messageIndex === "number")).toBe(true);

			const assistantWithToolCall = body.messages.find(
				(msg) => msg.role === "assistant" && Array.isArray((msg.metadata as { tool_calls?: unknown[] } | null)?.tool_calls),
			);
			expect(assistantWithToolCall).toBeDefined();
			expect((assistantWithToolCall?.metadata as { tool_calls: Array<{ id: string }> }).tool_calls[0]?.id).toBe("tc1");

			const toolMessage = body.messages.find((msg) => msg.role === "tool");
			expect(toolMessage).toBeDefined();
			expect((toolMessage?.metadata as { tool_call_id: string }).tool_call_id).toBe("tc1");
		} finally {
			started.server.stop(true);
			db.close();
		}
	});
});
