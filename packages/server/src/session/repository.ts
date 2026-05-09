import type { Database } from "bun:sqlite";

export interface Session {
	id: string;
	title: string | null;
	model: string | null;
	provider: string | null;
	apiFamily: string | null;
	parentId: string | null;
	promptTokens: number;
	promptChars: number;
	contextLimit: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredMessage {
	id: string;
	sessionId: string;
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	createdAt: string;
	sortOrder: number;
	metadata: Record<string, unknown> | null;
}

type SessionRow = {
	id: string;
	title: string | null;
	model: string | null;
	provider: string | null;
	api_family: string | null;
	parent_id: string | null;
	prompt_tokens: number;
	prompt_chars: number;
	context_limit: number | null;
	created_at: string;
	updated_at: string;
};
type MessageRow = {
	id: string;
	session_id: string;
	role: string;
	content: string;
	created_at: string;
	sort_order: number;
	metadata: string | null;
};

export function createSession(db: Database, options?: { provider?: string; model?: string; apiFamily?: string }): Session {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const provider = options?.provider ?? null;
	const model = options?.model ?? null;
	const apiFamily = options?.apiFamily ?? null;

	db.prepare(
		"INSERT INTO sessions (id, title, model, provider, api_family, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(id, null, model, provider, apiFamily, now, now);

	return {
		id,
		title: null,
		model,
		provider,
		apiFamily,
		parentId: null,
		promptTokens: 0,
		promptChars: 0,
		contextLimit: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function appendMessage(
	db: Database,
	sessionId: string,
	role: "user" | "assistant" | "tool",
	content: string,
	metadata?: Record<string, unknown>,
): StoredMessage {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const metadataJson = metadata ? JSON.stringify(metadata) : null;

	db.transaction(() => {
		db.prepare(
			`INSERT INTO messages (id, session_id, role, content, created_at, sort_order, metadata)
			 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_id = ?), ?)`,
		).run(id, sessionId, role, content, now, sessionId, metadataJson);

		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
	})();

	// Read back the sort_order that was assigned
	const row = db.prepare("SELECT sort_order FROM messages WHERE id = ?").get(id) as { sort_order: number };

	return { id, sessionId, role, content, createdAt: now, sortOrder: row.sort_order, metadata: metadata ?? null };
}

export function updateMessageMetadata(db: Database, messageId: string, patch: Record<string, unknown>): void {
	const row = db.prepare("SELECT metadata FROM messages WHERE id = ?").get(messageId) as { metadata: string | null } | null;
	if (!row) return;
	const existing = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
	const merged = { ...existing, ...patch };
	db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(JSON.stringify(merged), messageId);
}

export function getMessages(db: Database, sessionId: string): StoredMessage[] {
	const rows = db
		.prepare(
			"SELECT id, session_id, role, content, created_at, sort_order, metadata FROM messages WHERE session_id = ? ORDER BY sort_order",
		)
		.all(sessionId) as MessageRow[];

	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		role: r.role as "system" | "user" | "assistant" | "tool",
		content: r.content,
		createdAt: r.created_at,
		sortOrder: r.sort_order,
		metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
	}));
}

export function getSession(db: Database, sessionId: string): Session | null {
	const row = db
		.prepare(
			"SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE id = ?",
		)
		.get(sessionId) as SessionRow | null;

	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		provider: row.provider,
		apiFamily: row.api_family,
		parentId: row.parent_id,
		promptTokens: row.prompt_tokens,
		promptChars: row.prompt_chars,
		contextLimit: row.context_limit,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function getRecentPrompts(db: Database, limit: number): string[] {
	const rows = db
		.prepare(
			`SELECT content, MAX(created_at) AS latest, MAX(rowid) AS max_rowid
			 FROM messages
			 WHERE role = 'user'
			   AND (metadata IS NULL OR json_extract(metadata, '$.source') IS NULL OR json_extract(metadata, '$.source') != 'agent')
			   AND (metadata IS NULL OR json_extract(metadata, '$.purpose') IS NULL)
			 GROUP BY content
			 ORDER BY latest DESC, max_rowid DESC
			 LIMIT ?`,
		)
		.all(limit) as { content: string; latest: string; max_rowid: number }[];

	return rows.map((r) => r.content);
}

export function listSessions(db: Database, limit?: number): Session[] {
	const sql = limit
		? "SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?"
		: "SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC";
	const rows = (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		provider: r.provider,
		apiFamily: r.api_family,
		parentId: r.parent_id,
		promptTokens: r.prompt_tokens,
		promptChars: r.prompt_chars,
		contextLimit: r.context_limit,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

export function updateSessionModel(db: Database, sessionId: string, model: string): void {
	db.prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, new Date().toISOString(), sessionId);
}

export function updateSessionBackend(
	db: Database,
	sessionId: string,
	backend: { provider: string; model: string; apiFamily: string },
): void {
	db.prepare(
		"UPDATE sessions SET provider = ?, model = ?, api_family = ?, context_limit = NULL, updated_at = ? WHERE id = ?",
	).run(backend.provider, backend.model, backend.apiFamily, new Date().toISOString(), sessionId);
}

export function updateSessionTitle(db: Database, sessionId: string, title: string): void {
	db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), sessionId);
}

export function updateSessionPromptTokens(db: Database, sessionId: string, promptTokens: number, promptChars: number): void {
	db.prepare("UPDATE sessions SET prompt_tokens = ?, prompt_chars = ?, updated_at = ? WHERE id = ?").run(
		promptTokens,
		promptChars,
		new Date().toISOString(),
		sessionId,
	);
}

export function countSessionMessages(db: Database, sessionId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId) as { count: number };
	return row.count;
}

export function createSubagentSession(
	db: Database,
	parentId: string,
	title: string,
	model: string,
	provider: string,
	apiFamily: string,
): Session & { parentId: string } {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare(
		"INSERT INTO sessions (id, title, model, provider, api_family, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(id, title, model, provider, apiFamily, parentId, now, now);

	return {
		id,
		title,
		model,
		provider,
		apiFamily,
		parentId,
		promptTokens: 0,
		promptChars: 0,
		contextLimit: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function listSubagentSessions(db: Database, parentId: string, limit?: number): Session[] {
	const sql = limit
		? "SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?"
		: "SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC, rowid DESC";
	const rows = (limit ? db.prepare(sql).all(parentId, limit) : db.prepare(sql).all(parentId)) as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		provider: r.provider,
		apiFamily: r.api_family,
		parentId: r.parent_id,
		promptTokens: r.prompt_tokens,
		promptChars: r.prompt_chars,
		contextLimit: r.context_limit,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

export function getMostRecentParentSession(db: Database): Session | null {
	const row = db
		.prepare(
			"SELECT id, title, model, provider, api_family, parent_id, prompt_tokens, prompt_chars, context_limit, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1",
		)
		.get() as SessionRow | null;

	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		provider: row.provider,
		apiFamily: row.api_family,
		parentId: row.parent_id,
		promptTokens: row.prompt_tokens,
		promptChars: row.prompt_chars,
		contextLimit: row.context_limit,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function deleteSession(db: Database, sessionId: string): void {
	db.transaction(() => {
		// Delete messages of child (subagent) sessions
		db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE parent_id = ?)").run(sessionId);
		// Delete child sessions
		db.prepare("DELETE FROM sessions WHERE parent_id = ?").run(sessionId);
		// Delete messages of the target session
		db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
		// Delete the target session
		db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
	})();
}

export function updateSessionContextLimit(db: Database, sessionId: string, contextLimit: number): void {
	db.prepare("UPDATE sessions SET context_limit = ?, updated_at = ? WHERE id = ?").run(
		contextLimit,
		new Date().toISOString(),
		sessionId,
	);
}

export function clearSessionContextLimit(db: Database, sessionId: string): void {
	db.prepare("UPDATE sessions SET context_limit = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
}

export function getDescendantSessionIds(db: Database, parentId: string): string[] {
	const result: string[] = [];
	const queue = [parentId];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		const rows = db.prepare("SELECT id FROM sessions WHERE parent_id = ?").all(current) as { id: string }[];
		for (const row of rows) {
			result.push(row.id);
			queue.push(row.id);
		}
	}
	return result;
}

export interface AssistantTurnRecord {
	sessionId: string;
	turnModel: string | null;
	inputTokensTotal: number | null;
	outputTokensTotal: number | null;
}

export function getAssistantMessagesWithTurnMetrics(db: Database, sessionIds: string[]): AssistantTurnRecord[] {
	if (sessionIds.length === 0) return [];
	const placeholders = sessionIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT session_id, metadata FROM messages
			 WHERE session_id IN (${placeholders})
			   AND role = 'assistant'
			   AND metadata IS NOT NULL`,
		)
		.all(...sessionIds) as { session_id: string; metadata: string }[];

	return rows
		.map((r) => {
			const metadata = JSON.parse(r.metadata) as Record<string, unknown>;
			const turnModel = typeof metadata.turn_model === "string" ? metadata.turn_model : null;
			const turnMetrics = metadata.turn_metrics as Record<string, number> | undefined;
			return {
				sessionId: r.session_id,
				turnModel,
				inputTokensTotal: turnMetrics?.input_tokens_total ?? null,
				outputTokensTotal: turnMetrics?.output_tokens_total ?? null,
			};
		})
		.filter((r) => r.turnModel !== null);
}
