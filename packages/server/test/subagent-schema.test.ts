import { describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers";

describe("subagent schema", () => {
	test("sessions table has parent_id column", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const parentId = crypto.randomUUID();
		const now = new Date().toISOString();

		// Insert parent session first
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(parentId, null, now, now);
		// Insert child session with parent_id
		db.prepare("INSERT INTO sessions (id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			id,
			"child",
			parentId,
			now,
			now,
		);

		const row = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(id) as { parent_id: string };
		expect(row.parent_id).toBe(parentId);
		db.close();
	});

	test("parent_id enforces foreign key constraint", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		expect(() => {
			db.prepare("INSERT INTO sessions (id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
				id,
				"orphan",
				"non-existent-parent-id",
				now,
				now,
			);
		}).toThrow();
		db.close();
	});

	test("parent_id is nullable", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);

		const row = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(id) as { parent_id: string | null };
		expect(row.parent_id).toBeNull();
		db.close();
	});
});
