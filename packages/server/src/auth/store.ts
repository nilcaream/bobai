import fs from "node:fs";
import path from "node:path";

export interface StoredAuth {
	refresh: string;
	access: string;
	expires: number;
}

export function saveAuth(configDir: string, auth: StoredAuth): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	fs.writeFileSync(filePath, JSON.stringify(auth, null, "\t"), { mode: 0o600 });
}

export function loadAuth(configDir: string): StoredAuth | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (typeof raw.refresh === "string" && typeof raw.access === "string" && typeof raw.expires === "number") {
			return { refresh: raw.refresh, access: raw.access, expires: raw.expires };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// --- legacy exports (kept for backward compat until later tasks migrate callers) ---

interface StoredToken {
	token: string;
}

export function saveToken(configDir: string, token: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, "auth.json");
	const data: StoredToken = { token };
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
}

export function loadToken(configDir: string): string | undefined {
	try {
		const filePath = path.join(configDir, "auth.json");
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredToken;
		return raw.token;
	} catch {
		return undefined;
	}
}
