import { afterEach, describe, expect, mock, test } from "bun:test";
import { requestDeviceCode } from "../src/auth/device-flow";

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
		expect(body.client_id).toBe("Ov23lilOtSxsmULu7KfI");
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

		expect(requestDeviceCode()).rejects.toThrow("Failed to request device code");
	});
});
