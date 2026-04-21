import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type AuthStore,
	getCopilotAuth,
	getOpenRouterAuth,
	loadAuthStore,
	saveAuthStore,
	setCopilotAuth,
	setOpenRouterAuth,
} from "../src/auth/store";

describe("auth store", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("saveAuthStore creates auth.json with correct permissions", () => {
		saveAuthStore(tmpDir, { version: 1, providers: {} });
		const filePath = path.join(tmpDir, "auth.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const stat = fs.statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("round-trips a provider-keyed auth document", () => {
		const store: AuthStore = {
			version: 1,
			providers: {
				"github-copilot": {
					refresh: "refresh-token",
					access: "access-token",
					expires: 123,
				},
				openrouter: {
					apiKey: "or-key",
				},
			},
		};

		saveAuthStore(tmpDir, store);
		expect(loadAuthStore(tmpDir)).toEqual(store);
	});

	test("setCopilotAuth stores copilot credentials under github-copilot", () => {
		const store: AuthStore = { version: 1, providers: {} };
		const next = setCopilotAuth(store, { refresh: "r", access: "a", expires: 1 });
		expect(getCopilotAuth(next)).toEqual({ refresh: "r", access: "a", expires: 1 });
	});

	test("setOpenRouterAuth stores api key under openrouter", () => {
		const store: AuthStore = { version: 1, providers: {} };
		const next = setOpenRouterAuth(store, { apiKey: "key-123" });
		expect(getOpenRouterAuth(next)).toEqual({ apiKey: "key-123" });
	});

	test("setOpenRouterAuth overwrites an existing key", () => {
		const store: AuthStore = {
			version: 1,
			providers: {
				openrouter: { apiKey: "old" },
			},
		};
		const next = setOpenRouterAuth(store, { apiKey: "new" });
		expect(getOpenRouterAuth(next)).toEqual({ apiKey: "new" });
	});

	test("loadAuthStore returns undefined when file is missing", () => {
		expect(loadAuthStore(tmpDir)).toBeUndefined();
	});

	test("loadAuthStore returns undefined for corrupt JSON", () => {
		fs.writeFileSync(path.join(tmpDir, "auth.json"), "not json");
		expect(loadAuthStore(tmpDir)).toBeUndefined();
	});
});
