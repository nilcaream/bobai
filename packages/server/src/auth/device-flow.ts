const CLIENT_ID = "Ov23lilOtSxsmULu7KfI";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
	const response = await fetch(GITHUB_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	return (await response.json()) as DeviceCodeResponse;
}
