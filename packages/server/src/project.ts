import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface BobaiConfig {
	id?: string;
	port?: number;
	provider?: string;
	model?: string;
}

export interface Project {
	id: string;
	port?: number;
	provider?: string;
	model?: string;
	dir: string;
	db: Database;
}

export async function initProject(projectRoot: string): Promise<Project> {
	const bobaiDir = path.join(projectRoot, ".bobai");
	const projectFile = path.join(bobaiDir, "bobai.json");
	const dbFile = path.join(bobaiDir, "bobai.db");

	fs.mkdirSync(bobaiDir, { recursive: true });

	let config: BobaiConfig = {};
	if (fs.existsSync(projectFile)) {
		config = JSON.parse(fs.readFileSync(projectFile, "utf8")) as BobaiConfig;
	}

	const id = config.id ?? crypto.randomUUID();
	if (!config.id) {
		config = { ...config, id };
		fs.writeFileSync(projectFile, JSON.stringify(config, null, 2));
	}

	const db = new Database(dbFile, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");

	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id         TEXT PRIMARY KEY,
			title      TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id         TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role       TEXT NOT NULL,
			content    TEXT NOT NULL,
			created_at TEXT NOT NULL,
			sort_order INTEGER NOT NULL,
			metadata   TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sort_order)`);

	return { id, port: config.port, provider: config.provider, model: config.model, dir: bobaiDir, db };
}
