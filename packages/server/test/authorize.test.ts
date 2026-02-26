import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorize } from "../src/auth/authorize";

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

	test("runs device flow and persists token", async () => {
		let callCount = 0;

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const u = url.toString();
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
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_final", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const token = await authorize(tmpDir);

		expect(token).toBe("gho_final");
		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
		expect(raw.token).toBe("gho_final");
	});

	test("forwards custom clientId to device flow", async () => {
		let capturedBody = "";

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const u = url.toString();
			if (u.includes("/login/device/code")) {
				capturedBody = init?.body as string;
				return new Response(
					JSON.stringify({
						device_code: "dc_custom",
						user_code: "CUST-CODE",
						verification_uri: "https://github.com/login/device",
						interval: 0,
						expires_in: 900,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ access_token: "gho_custom", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await authorize(tmpDir, "Iv1.customid");

		const body = JSON.parse(capturedBody);
		expect(body.client_id).toBe("Iv1.customid");
	});
});
