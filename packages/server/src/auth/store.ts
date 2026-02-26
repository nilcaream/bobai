import fs from "node:fs";
import path from "node:path";

interface StoredAuth {
	token: string;
}

export function saveToken(configDir: string, token: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	const data: StoredAuth = { token };
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
}

export function loadToken(configDir: string): string | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredAuth;
		return raw.token;
	} catch {
		return undefined;
	}
}
