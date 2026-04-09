import { Database } from "bun:sqlite";

export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT,
			parent_id TEXT REFERENCES sessions(id),
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			prompt_chars INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			sort_order INTEGER NOT NULL,
			metadata TEXT
		)
	`);
	db.exec("CREATE INDEX idx_messages_session ON messages(session_id, sort_order)");
	return db;
}
