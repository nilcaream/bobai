import { pollForToken, requestDeviceCode } from "./device-flow";
import { saveToken } from "./store";

export async function authorize(configDir: string, providerId: string): Promise<string> {
	console.log("Authenticating with GitHub Copilot...\n");

	const deviceCode = await requestDeviceCode();

	console.log(`  Open: ${deviceCode.verification_uri}`);
	console.log(`  Enter code: ${deviceCode.user_code}\n`);
	console.log("Waiting for authorization...");

	const token = await pollForToken(deviceCode.device_code, deviceCode.interval);

	saveToken(configDir, providerId, token);
	console.log("Authenticated successfully.\n");

	return token;
}
