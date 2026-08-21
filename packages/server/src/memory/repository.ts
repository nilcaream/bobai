import type { Database } from "bun:sqlite";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
	return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export interface Memory {
	id: string;
	type: MemoryType;
	title: string;
	description: string | null;
	content: string;
	sessionId: string | null;
	createdAt: string;
	updatedAt: string;
}

type MemoryRow = {
	id: string;
	type: string;
	title: string;
	description: string | null;
	content: string;
	session_id: string | null;
	created_at: string;
	updated_at: string;
};

function mapRow(r: MemoryRow): Memory {
	return {
		id: r.id,
		type: r.type as MemoryType,
		title: r.title,
		description: r.description,
		content: r.content,
		sessionId: r.session_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

const SELECT_COLUMNS = "id, type, title, description, content, session_id, created_at, updated_at";

/** Create the memories table and index if they don't exist. Idempotent. */
export function ensureMemoriesSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memories (
			id          TEXT PRIMARY KEY,
			type        TEXT NOT NULL,
			title       TEXT NOT NULL,
			description TEXT,
			content     TEXT NOT NULL,
			session_id  TEXT,
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)");
}

export function listMemories(db: Database, options?: { type?: MemoryType }): Memory[] {
	const rows = options?.type
		? (db
				.prepare(`SELECT ${SELECT_COLUMNS} FROM memories WHERE type = ? ORDER BY updated_at DESC, rowid DESC`)
				.all(options.type) as MemoryRow[])
		: (db.prepare(`SELECT ${SELECT_COLUMNS} FROM memories ORDER BY updated_at DESC, rowid DESC`).all() as MemoryRow[]);
	return rows.map(mapRow);
}

export function getMemory(db: Database, id: string): Memory | null {
	const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | null;
	return row ? mapRow(row) : null;
}

/** Find a memory by title (case-insensitive). Most recently updated wins. */
export function findMemoryByTitle(db: Database, title: string): Memory | null {
	const row = db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM memories WHERE lower(title) = lower(?) ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
		)
		.get(title) as MemoryRow | null;
	return row ? mapRow(row) : null;
}

export interface CreateMemoryInput {
	type: MemoryType;
	title: string;
	description?: string;
	content: string;
	sessionId?: string;
}

export function createMemory(db: Database, input: CreateMemoryInput): Memory {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, type, title, description, content, session_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(id, input.type, input.title, input.description ?? null, input.content, input.sessionId ?? null, now, now);
	return {
		id,
		type: input.type,
		title: input.title,
		description: input.description ?? null,
		content: input.content,
		sessionId: input.sessionId ?? null,
		createdAt: now,
		updatedAt: now,
	};
}

export interface UpdateMemoryPatch {
	type?: MemoryType;
	title?: string;
	description?: string | null;
	content?: string;
}

/** Update memory fields in place. Returns the updated memory, or null if not found. */
export function updateMemory(db: Database, id: string, patch: UpdateMemoryPatch): Memory | null {
	const existing = getMemory(db, id);
	if (!existing) return null;

	const next = {
		type: patch.type ?? existing.type,
		title: patch.title ?? existing.title,
		description: patch.description !== undefined ? patch.description : existing.description,
		content: patch.content ?? existing.content,
	};

	const now = new Date().toISOString();
	db.prepare("UPDATE memories SET type = ?, title = ?, description = ?, content = ?, updated_at = ? WHERE id = ?").run(
		next.type,
		next.title,
		next.description,
		next.content,
		now,
		id,
	);

	return { ...existing, ...next, updatedAt: now };
}

/** Delete a memory by id. Returns true when a row was removed. */
export function deleteMemory(db: Database, id: string): boolean {
	db.prepare("DELETE FROM memories WHERE id = ?").run(id);
	const row = db.query("SELECT changes() as count").get() as { count: number };
	return row.count > 0;
}

/** Keyword search across title, description, and content. Most recent first. */
export function searchMemories(db: Database, query: string, limit = 20): Memory[] {
	const like = `%${query}%`;
	const rows = db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM memories
			 WHERE title LIKE ? OR description LIKE ? OR content LIKE ?
			 ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
		)
		.all(like, like, like, limit) as MemoryRow[];
	return rows.map(mapRow);
}
