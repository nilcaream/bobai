import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorize } from "../src/auth/authorize";
import type { StoredAuth } from "../src/auth/store";

const SESSION_TOKEN = "tid=session;proxy-ep=proxy.individual.githubcopilot.com";
const SESSION_EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600;

function createMockFetch() {
	let pollCount = 0;
	return mock(async (url: string | URL | Request, _init?: RequestInit) => {
		const u = url.toString();

		// 1. Device code request
		if (u.includes("/login/device/code")) {
			return new Response(
				JSON.stringify({
					device_code: "dc_test",
					user_code: "TEST-CODE",
					verification_uri: "https://github.com/login/device",
					interval: 0,
					expires_in: 900,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		// 2. Token polling (OAuth access_token)
		if (u.includes("/login/oauth/access_token")) {
			pollCount++;
			if (pollCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_final", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// 3. Token exchange (Copilot session)
		if (u.includes("copilot_internal/v2/token")) {
			return new Response(JSON.stringify({ token: SESSION_TOKEN, expires_at: SESSION_EXPIRES_AT }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not found", { status: 404 });
	}) as typeof fetch;
}

describe("authorize", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("runs device flow, exchanges, and persists auth", async () => {
		globalThis.fetch = createMockFetch();

		const result = await authorize(tmpDir);

		// Returns StoredAuth, not a string
		expect(typeof result).toBe("object");
		expect(result.refresh).toBe("gho_final");
		expect(result.access).toBe(SESSION_TOKEN);
		expect(typeof result.expires).toBe("number");

		// Verify persisted auth.json matches StoredAuth shape
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as StoredAuth;
		expect(raw.refresh).toBe("gho_final");
		expect(raw.access).toBe(SESSION_TOKEN);
		expect(typeof raw.expires).toBe("number");

		// Return value matches saved format
		expect(result).toEqual(raw);
	});
});
