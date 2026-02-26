import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CLIENT_ID, pollForToken, requestDeviceCode } from "../src/auth/device-flow";

describe("requestDeviceCode", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends correct request and returns parsed response", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(
				JSON.stringify({
					device_code: "dc_123",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const result = await requestDeviceCode();

		expect(capturedUrl).toBe("https://github.com/login/device/code");
		expect(capturedInit?.method).toBe("POST");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.client_id).toBe(DEFAULT_CLIENT_ID);
		expect(body.scope).toBe("read:user");
		expect(result.device_code).toBe("dc_123");
		expect(result.user_code).toBe("ABCD-1234");
		expect(result.verification_uri).toBe("https://github.com/login/device");
		expect(result.interval).toBe(5);
	});

	test("throws on non-OK response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Bad Request", { status: 400 });
		}) as typeof fetch;

		await expect(requestDeviceCode()).rejects.toThrow("Failed to request device code");
	});

	test("uses custom clientId when provided", async () => {
		let capturedBody = "";

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = init?.body as string;
			return new Response(
				JSON.stringify({
					device_code: "dc_custom",
					user_code: "CUST-1234",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		await requestDeviceCode("Iv1.customclientid");
		const body = JSON.parse(capturedBody);
		expect(body.client_id).toBe("Iv1.customclientid");
	});
});

describe("pollForToken", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns access_token after authorization_pending then success", async () => {
		let callCount = 0;

		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_abc123", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const token = await pollForToken("dc_123", 0);
		expect(token).toBe("gho_abc123");
		expect(callCount).toBe(2);
	});

	test("throws on expired_token error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "expired_token" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await expect(pollForToken("dc_expired", 0)).rejects.toThrow("expired");
	});

	test("throws on access_denied error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ error: "access_denied" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await expect(pollForToken("dc_denied", 0)).rejects.toThrow("denied");
	});

	test("backs off on slow_down then succeeds", async () => {
		let callCount = 0;

		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "slow_down", interval: 10 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_slowed", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const noopSleep = async () => {};
		const token = await pollForToken("dc_slow", 0, noopSleep);
		expect(token).toBe("gho_slowed");
		expect(callCount).toBe(2);
	});

	test("throws on non-OK HTTP response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("Internal Server Error", { status: 500 });
		}) as typeof fetch;

		await expect(pollForToken("dc_err", 0)).rejects.toThrow("Token poll failed: HTTP 500");
	});

	test("uses custom clientId in token poll", async () => {
		let capturedBody = "";

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = init?.body as string;
			return new Response(JSON.stringify({ access_token: "gho_custom", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const noopSleep = async () => {};
		await pollForToken("dc_123", 0, noopSleep, "Iv1.customclientid");
		const body = JSON.parse(capturedBody);
		expect(body.client_id).toBe("Iv1.customclientid");
	});
});
