import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTime } from "../src/file/time";

describe("FileTime", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-filetime-"));
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	afterEach(() => {
		FileTime.clearSession("test-session");
	});

	test("assert throws when file was never read", () => {
		const file = path.join(tmpDir, "never-read.ts");
		fs.writeFileSync(file, "hello");
		expect(() => FileTime.assert("test-session", file)).toThrow("must read");
	});

	test("assert passes after read when file is unchanged", () => {
		const file = path.join(tmpDir, "stable.ts");
		fs.writeFileSync(file, "hello");
		FileTime.read("test-session", file);
		expect(() => FileTime.assert("test-session", file)).not.toThrow();
	});

	test("assert throws when file was modified after read", async () => {
		const file = path.join(tmpDir, "modified.ts");
		fs.writeFileSync(file, "original");
		FileTime.read("test-session", file);
		// Ensure mtime changes (some filesystems have 1s resolution)
		await Bun.sleep(50);
		fs.writeFileSync(file, "changed content");
		expect(() => FileTime.assert("test-session", file)).toThrow("modified since");
	});

	test("read after write refreshes stamp, allowing subsequent assert", async () => {
		const file = path.join(tmpDir, "refresh.ts");
		fs.writeFileSync(file, "v1");
		FileTime.read("test-session", file);
		await Bun.sleep(50);
		fs.writeFileSync(file, "v2");
		// Re-read to refresh
		FileTime.read("test-session", file);
		expect(() => FileTime.assert("test-session", file)).not.toThrow();
	});

	test("sessions are isolated", () => {
		const file = path.join(tmpDir, "isolated.ts");
		fs.writeFileSync(file, "data");
		FileTime.read("session-a", file);
		expect(() => FileTime.assert("session-b", file)).toThrow("must read");
		// Clean up
		FileTime.clearSession("session-a");
		FileTime.clearSession("session-b");
	});

	test("invalidate marks a file as stale, causing assert to throw", () => {
		const file = path.join(tmpDir, "invalidated.ts");
		fs.writeFileSync(file, "data");
		FileTime.read("test-session", file);
		FileTime.invalidate("test-session", file);
		expect(() => FileTime.assert("test-session", file)).toThrow("must read");
	});

	test("clearSession removes all stamps for a session", () => {
		const file1 = path.join(tmpDir, "clear1.ts");
		const file2 = path.join(tmpDir, "clear2.ts");
		fs.writeFileSync(file1, "a");
		fs.writeFileSync(file2, "b");
		FileTime.read("test-session", file1);
		FileTime.read("test-session", file2);
		FileTime.clearSession("test-session");
		expect(() => FileTime.assert("test-session", file1)).toThrow("must read");
		expect(() => FileTime.assert("test-session", file2)).toThrow("must read");
	});

	test("assert throws when file was deleted after read", () => {
		const file = path.join(tmpDir, "will-delete.ts");
		fs.writeFileSync(file, "temp");
		FileTime.read("test-session", file);
		fs.unlinkSync(file);
		// File gone → stat will differ → should throw
		expect(() => FileTime.assert("test-session", file)).toThrow("modified since");
	});
});
