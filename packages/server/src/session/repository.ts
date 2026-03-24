import type { Database } from "bun:sqlite";

export interface Session {
	id: string;
	title: string | null;
	model: string | null;
	parentId: string | null;
	promptTokens: number;
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
	parent_id: string | null;
	prompt_tokens: number;
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

export function createSession(db: Database): Session {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);

	return { id, title: null, model: null, parentId: null, promptTokens: 0, createdAt: now, updatedAt: now };
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
		.prepare("SELECT id, title, model, parent_id, prompt_tokens, created_at, updated_at FROM sessions WHERE id = ?")
		.get(sessionId) as SessionRow | null;

	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		parentId: row.parent_id,
		promptTokens: row.prompt_tokens,
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
		? "SELECT id, title, model, parent_id, prompt_tokens, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?"
		: "SELECT id, title, model, parent_id, prompt_tokens, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC";
	const rows = (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		parentId: r.parent_id,
		promptTokens: r.prompt_tokens,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

export function updateSessionModel(db: Database, sessionId: string, model: string): void {
	db.prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, new Date().toISOString(), sessionId);
}

export function updateSessionTitle(db: Database, sessionId: string, title: string): void {
	db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), sessionId);
}

export function updateSessionPromptTokens(db: Database, sessionId: string, promptTokens: number): void {
	db.prepare("UPDATE sessions SET prompt_tokens = ?, updated_at = ? WHERE id = ?").run(
		promptTokens,
		new Date().toISOString(),
		sessionId,
	);
}

export function createSubagentSession(
	db: Database,
	parentId: string,
	title: string,
	model: string,
): Session & { parentId: string } {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare("INSERT INTO sessions (id, title, model, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		id,
		title,
		model,
		parentId,
		now,
		now,
	);

	return { id, title, model, parentId, promptTokens: 0, createdAt: now, updatedAt: now };
}

export function listSubagentSessions(db: Database, parentId: string, limit = 9): Session[] {
	const rows = db
		.prepare(
			"SELECT id, title, model, parent_id, prompt_tokens, created_at, updated_at FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?",
		)
		.all(parentId, limit) as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		parentId: r.parent_id,
		promptTokens: r.prompt_tokens,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

export function getMostRecentParentSession(db: Database): Session | null {
	const row = db
		.prepare(
			"SELECT id, title, model, parent_id, prompt_tokens, created_at, updated_at FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1",
		)
		.get() as SessionRow | null;

	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		parentId: row.parent_id,
		promptTokens: row.prompt_tokens,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
