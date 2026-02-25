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
		saveToken(tmpDir, "github-copilot", "gho_abc");
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("saveToken writes provider-keyed token", () => {
		saveToken(tmpDir, "github-copilot", "gho_abc");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw["github-copilot"].token).toBe("gho_abc");
		expect(raw["github-copilot"].type).toBe("oauth");
	});

	test("saveToken preserves existing provider entries", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({ other: { token: "keep" } }));
		saveToken(tmpDir, "github-copilot", "gho_new");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.other.token).toBe("keep");
		expect(raw["github-copilot"].token).toBe("gho_new");
	});

	test("loadToken returns token when present", () => {
		saveToken(tmpDir, "github-copilot", "gho_abc");
		expect(loadToken(tmpDir, "github-copilot")).toBe("gho_abc");
	});

	test("loadToken returns undefined when missing", () => {
		expect(loadToken(tmpDir, "github-copilot")).toBeUndefined();
	});
});
