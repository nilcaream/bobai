import type { Database } from "bun:sqlite";

export interface Session {
	id: string;
	title: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredMessage {
	id: string;
	sessionId: string;
	role: "system" | "user" | "assistant";
	content: string;
	createdAt: string;
	sortOrder: number;
}

type SessionRow = { id: string; title: string | null; created_at: string; updated_at: string };
type MessageRow = { id: string; session_id: string; role: string; content: string; created_at: string; sort_order: number };

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

	return { id, title: null, createdAt: now, updatedAt: now };
}

export function appendMessage(db: Database, sessionId: string, role: "user" | "assistant", content: string): StoredMessage {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.transaction(() => {
		db.prepare(
			`INSERT INTO messages (id, session_id, role, content, created_at, sort_order)
			 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_id = ?))`,
		).run(id, sessionId, role, content, now, sessionId);

		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
	})();

	// Read back the sort_order that was assigned
	const row = db.prepare("SELECT sort_order FROM messages WHERE id = ?").get(id) as { sort_order: number };

	return { id, sessionId, role, content, createdAt: now, sortOrder: row.sort_order };
}

export function getMessages(db: Database, sessionId: string): StoredMessage[] {
	const rows = db
		.prepare(
			"SELECT id, session_id, role, content, created_at, sort_order FROM messages WHERE session_id = ? ORDER BY sort_order",
		)
		.all(sessionId) as MessageRow[];

	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		role: r.role as "system" | "user" | "assistant",
		content: r.content,
		createdAt: r.created_at,
		sortOrder: r.sort_order,
	}));
}

export function getSession(db: Database, sessionId: string): Session | null {
	const row = db
		.prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?")
		.get(sessionId) as SessionRow | null;

	if (!row) return null;
	return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listSessions(db: Database): Session[] {
	const rows = db
		.prepare("SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC, rowid DESC")
		.all() as SessionRow[];

	return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}
