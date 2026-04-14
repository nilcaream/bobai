import fs from "node:fs";

export class DbDisconnectedError extends Error {
	constructor(dbPath: string) {
		super(
			`Database disconnected: the file at ${dbPath} was replaced or deleted while the server was running. Restart the server to reconnect.`,
		);
		this.name = "DbDisconnectedError";
	}
}

export interface DbGuard {
	/** Throws DbDisconnectedError if the db file has been replaced or deleted. */
	assertConnected(): void;
	/** Returns false if the db file has been replaced or deleted. */
	isConnected(): boolean;
}

export function createDbGuard(dbPath: string): DbGuard {
	const originalIno = fs.statSync(dbPath).ino;
	let disconnected = false;

	function check(): boolean {
		if (disconnected) return false;
		try {
			const current = fs.statSync(dbPath);
			if (current.ino !== originalIno) {
				disconnected = true;
				return false;
			}
			return true;
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				disconnected = true;
				return false;
			}
			throw e;
		}
	}

	return {
		assertConnected() {
			if (!check()) {
				throw new DbDisconnectedError(dbPath);
			}
		},
		isConnected() {
			return check();
		},
	};
}
