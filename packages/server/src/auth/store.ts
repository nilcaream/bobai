import fs from "node:fs";
import path from "node:path";

interface StoredAuth {
	token: string;
	type?: string;
}

export function saveToken(configDir: string, providerId: string, token: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");

	let existing: Record<string, StoredAuth> = {};
	try {
		existing = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, StoredAuth>;
	} catch {
		// file doesn't exist or invalid JSON
	}

	existing[providerId] = { token, type: "oauth" };

	fs.writeFileSync(filePath, JSON.stringify(existing, null, "\t"), { mode: 0o600 });
}

export function loadToken(configDir: string, providerId: string): string | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, StoredAuth>;
		return raw[providerId]?.token;
	} catch {
		return undefined;
	}
}
