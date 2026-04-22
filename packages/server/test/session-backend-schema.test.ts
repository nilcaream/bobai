import { describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers";

describe("session backend schema", () => {
	test("sessions table has provider and api_family columns", () => {
		const db = createTestDb();
		const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
		expect(columns.some((c) => c.name === "provider")).toBe(true);
		expect(columns.some((c) => c.name === "api_family")).toBe(true);
		db.close();
	});

	test("provider and api_family are nullable for backward compatibility", () => {
		const db = createTestDb();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, null, now, now);
		const row = db.prepare("SELECT provider, api_family FROM sessions WHERE id = ?").get(id) as {
			provider: string | null;
			api_family: string | null;
		};
		expect(row.provider).toBeNull();
		expect(row.api_family).toBeNull();
		db.close();
	});
});
