import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadToken, saveToken } from "../src/auth/store";

describe("auth store", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

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
});
