import { exchangeToken } from "../provider/copilot";
import { pollForToken, requestDeviceCode } from "./device-flow";
import { type StoredAuth, saveAuth } from "./store";

export async function authorize(
	configDir: string,
	clientId?: string,
	configHeaders?: Record<string, string>,
): Promise<StoredAuth> {
	console.log("Authenticating with GitHub Copilot");

	const deviceCode = await requestDeviceCode(clientId);

	console.log(`- Open: ${deviceCode.verification_uri}`);
	console.log(`- Enter code: ${deviceCode.user_code}`);

	console.log("");
	console.log("Waiting for authorization");

	const githubToken = await pollForToken(deviceCode.device_code, deviceCode.interval, undefined, clientId);
	console.log("- GitHub OAuth complete");

	console.log("");
	console.log("Exchanging token for Copilot session");
	const session = await exchangeToken(githubToken, configHeaders);
	console.log("- Session obtained");
	console.log("");

	const auth: StoredAuth = { refresh: githubToken, access: session.access, expires: session.expires };
	saveAuth(configDir, auth);

	return auth;
}
