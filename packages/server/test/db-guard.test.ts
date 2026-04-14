import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createDbGuard, DbDisconnectedError } from "../src/db-guard";

describe("DbGuard", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(".", "dbguard-test-"));
		dbPath = path.join(tmpDir, "bobai.db");
		fs.writeFileSync(dbPath, "fake-db-content");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("assertConnected succeeds when file is unchanged", () => {
		const guard = createDbGuard(dbPath);
		expect(() => guard.assertConnected()).not.toThrow();
	});

	test("assertConnected throws DbDisconnectedError when file is deleted", () => {
		const guard = createDbGuard(dbPath);
		fs.unlinkSync(dbPath);
		expect(() => guard.assertConnected()).toThrow(DbDisconnectedError);
	});

	test("assertConnected throws DbDisconnectedError when file is replaced (different inode)", () => {
		const guard = createDbGuard(dbPath);
		fs.unlinkSync(dbPath);
		// Create a dummy file to consume the recycled inode number
		fs.writeFileSync(path.join(tmpDir, "dummy"), "occupy-inode");
		fs.writeFileSync(dbPath, "replacement-content");
		expect(() => guard.assertConnected()).toThrow(DbDisconnectedError);
	});

	test("isConnected returns true when file is unchanged", () => {
		const guard = createDbGuard(dbPath);
		expect(guard.isConnected()).toBe(true);
	});

	test("isConnected returns false when file is deleted", () => {
		const guard = createDbGuard(dbPath);
		fs.unlinkSync(dbPath);
		expect(guard.isConnected()).toBe(false);
	});

	test("assertConnected always throws once disconnected (latched)", () => {
		const guard = createDbGuard(dbPath);

		// Delete the file and trigger detection
		fs.unlinkSync(dbPath);
		expect(guard.isConnected()).toBe(false);

		// Recreate the file at the same path
		fs.writeFileSync(dbPath, "new-content");

		// Should still throw — the latch is permanent
		expect(() => guard.assertConnected()).toThrow(DbDisconnectedError);
		expect(guard.isConnected()).toBe(false);
	});

	test("error message includes the db path", () => {
		const guard = createDbGuard(dbPath);
		fs.unlinkSync(dbPath);

		try {
			guard.assertConnected();
			throw new Error("Expected assertConnected to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(DbDisconnectedError);
			expect((e as DbDisconnectedError).message).toContain(dbPath);
		}
	});
});
