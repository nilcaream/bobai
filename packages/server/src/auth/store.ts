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
	// Atomic write: write to temp file in same directory, then rename.
	// rename() is atomic on the same filesystem, so readers never see a
	// truncated/partial file (e.g. if the process is killed mid-write).
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(auth, null, "\t"), { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
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
