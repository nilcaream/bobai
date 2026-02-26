export const DEFAULT_CLIENT_ID = "Ov23lilOtSxsmULu7KfI";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

export async function requestDeviceCode(clientId: string = DEFAULT_CLIENT_ID): Promise<DeviceCodeResponse> {
	const response = await fetch(GITHUB_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: clientId,
			scope: "read:user",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	return (await response.json()) as DeviceCodeResponse;
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface TokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

export async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
	clientId: string = DEFAULT_CLIENT_ID,
): Promise<string> {
	let interval = intervalSeconds;

	while (true) {
		if (interval > 0) {
			await sleep(interval * 1000);
		}

		const response = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (!response.ok) {
			throw new Error(`Token poll failed: HTTP ${response.status}`);
		}

		const data = (await response.json()) as TokenResponse;

		if (data.access_token) {
			return data.access_token;
		}

		if (data.error === "authorization_pending") {
			continue;
		}

		if (data.error === "slow_down") {
			interval = (data.interval ?? interval) + 5;
			continue;
		}

		throw new Error(data.error_description ?? data.error ?? "Unknown error during token polling");
	}
}
