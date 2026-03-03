import type { Database } from "bun:sqlite";

export interface Session {
	id: string;
	title: string | null;
	model: string | null;
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

type SessionRow = { id: string; title: string | null; model: string | null; created_at: string; updated_at: string };
type MessageRow = {
	id: string;
	session_id: string;
	role: string;
	content: string;
	created_at: string;
	sort_order: number;
	metadata: string | null;
};

export function createSession(db: Database, systemPrompt: string): Session {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.transaction(() => {
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);
		db.prepare("INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)").run(
			crypto.randomUUID(),
			id,
			"system",
			systemPrompt,
			now,
			0,
		);
	})();

	return { id, title: null, model: null, createdAt: now, updatedAt: now };
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
		.prepare("SELECT id, title, model, created_at, updated_at FROM sessions WHERE id = ?")
		.get(sessionId) as SessionRow | null;

	if (!row) return null;
	return { id: row.id, title: row.title, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getRecentPrompts(db: Database, limit: number): string[] {
	const rows = db
		.prepare(
			`SELECT content, MAX(created_at) AS latest, MAX(rowid) AS max_rowid
			 FROM messages
			 WHERE role = 'user'
			 GROUP BY content
			 ORDER BY latest DESC, max_rowid DESC
			 LIMIT ?`,
		)
		.all(limit) as { content: string; latest: string; max_rowid: number }[];

	return rows.map((r) => r.content);
}

export function listSessions(db: Database): Session[] {
	const rows = db
		.prepare("SELECT id, title, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC, rowid DESC")
		.all() as SessionRow[];

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
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
