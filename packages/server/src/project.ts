import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

export interface Project {
	id: string;
	dir: string;
	db: Database;
}

export async function initProject(projectRoot: string): Promise<Project> {
	const bobaiDir = path.join(projectRoot, ".bobai");
	const projectFile = path.join(bobaiDir, "bobai.json");
	const dbFile = path.join(bobaiDir, "bobai.db");

	fs.mkdirSync(bobaiDir, { recursive: true });

	let id: string;
	if (fs.existsSync(projectFile)) {
		const existing = JSON.parse(fs.readFileSync(projectFile, "utf8")) as { id?: string };
		id = existing.id ?? crypto.randomUUID();
		if (!existing.id) {
			fs.writeFileSync(projectFile, JSON.stringify({ ...existing, id }, null, 2));
		}
	} else {
		id = crypto.randomUUID();
		fs.writeFileSync(projectFile, JSON.stringify({ id }, null, 2));
	}

	const db = new Database(dbFile, { create: true });

	return { id, dir: bobaiDir, db };
}
