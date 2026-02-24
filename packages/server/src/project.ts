import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

export interface BobaiConfig {
	id?: string;
	port?: number;
}

export interface Project {
	id: string;
	port?: number;
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

	return { id, port: config.port, dir: bobaiDir, db };
}
