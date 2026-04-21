import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorizeCopilot, authorizeOpenRouter } from "../src/auth/authorize";
import type { AuthStore } from "../src/auth/store";

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

describe("authorizeCopilot", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("runs device flow, exchanges, and persists auth under github-copilot", async () => {
		globalThis.fetch = createMockFetch();

		const result = await authorizeCopilot(tmpDir);

		expect(typeof result).toBe("object");
		expect(result.refresh).toBe("gho_final");
		expect(result.access).toBe(SESSION_TOKEN);
		expect(typeof result.expires).toBe("number");

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.version).toBe(1);
		expect(raw.providers["github-copilot"]?.refresh).toBe("gho_final");
		expect(raw.providers["github-copilot"]?.access).toBe(SESSION_TOKEN);
		expect(typeof raw.providers["github-copilot"]?.expires).toBe("number");

		expect(result).toEqual(raw.providers["github-copilot"]);
	});

	test("saves validated OpenRouter key into auth store", async () => {
		await authorizeOpenRouter(tmpDir, {
			promptSecret: async () => "key-123",
			validateOpenRouterKey: async () => {},
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers.openrouter).toEqual({ apiKey: "key-123" });
	});

	test("does not save OpenRouter key when validation fails", async () => {
		await expect(
			authorizeOpenRouter(tmpDir, {
				promptSecret: async () => "bad-key",
				validateOpenRouterKey: async () => {
					throw new Error("Unauthorized");
				},
			}),
		).rejects.toThrow(/Unauthorized/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});
});
