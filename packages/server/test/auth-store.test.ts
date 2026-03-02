import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuth, loadToken, type StoredAuth, saveAuth, saveToken } from "../src/auth/store";

describe("auth store", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// --- legacy saveToken / loadToken (kept for backward compat) ---

	test("saveToken creates auth.json with correct permissions", () => {
		saveToken(tmpDir, "gho_abc");
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveToken writes flat token object", () => {
		saveToken(tmpDir, "gho_abc");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual({ token: "gho_abc" });
	});

	test("saveToken overwrites existing token", () => {
		saveToken(tmpDir, "gho_old");
		saveToken(tmpDir, "gho_new");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual({ token: "gho_new" });
	});

	test("loadToken returns token when present", () => {
		saveToken(tmpDir, "gho_abc");
		expect(loadToken(tmpDir)).toBe("gho_abc");
	});

	test("loadToken returns undefined when missing", () => {
		expect(loadToken(tmpDir)).toBeUndefined();
	});

	// --- new saveAuth / loadAuth ---

	test("saveAuth creates auth.json with correct permissions", () => {
		saveAuth(tmpDir, { refresh: "gho_abc", access: "tid=x;exp=y", expires: 1000 });
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveAuth writes all three fields", () => {
		const auth: StoredAuth = { refresh: "gho_abc", access: "tid=x", expires: 99999 };
		saveAuth(tmpDir, auth);
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw).toEqual(auth);
	});

	test("saveAuth overwrites existing auth", () => {
		saveAuth(tmpDir, { refresh: "old", access: "old", expires: 1 });
		saveAuth(tmpDir, { refresh: "new", access: "new", expires: 2 });
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.refresh).toBe("new");
	});

	test("loadAuth returns auth when present", () => {
		const auth: StoredAuth = { refresh: "gho_abc", access: "tid=x", expires: 99999 };
		saveAuth(tmpDir, auth);
		expect(loadAuth(tmpDir)).toEqual(auth);
	});

	test("loadAuth returns undefined when file is missing", () => {
		expect(loadAuth(tmpDir)).toBeUndefined();
	});

	test("loadAuth returns undefined for old format { token }", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({ token: "gho_old" }));
		expect(loadAuth(tmpDir)).toBeUndefined();
	});

	test("loadAuth returns undefined for corrupt JSON", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), "not json");
		expect(loadAuth(tmpDir)).toBeUndefined();
	});
});
