import fs from "node:fs";

interface Stamp {
	readonly mtime: number | undefined;
	readonly ctime: number | undefined;
	readonly size: number | undefined;
}

function stat(filepath: string): Stamp {
	try {
		const s = fs.statSync(filepath);
		return {
			mtime: s.mtimeMs,
			ctime: s.ctimeMs,
			size: s.size,
		};
	} catch {
		return { mtime: undefined, ctime: undefined, size: undefined };
	}
}

const sessions = new Map<string, Map<string, Stamp>>();

function getSession(sessionId: string): Map<string, Stamp> {
	let m = sessions.get(sessionId);
	if (!m) {
		m = new Map();
		sessions.set(sessionId, m);
	}
	return m;
}

function read(sessionId: string, filepath: string): void {
	getSession(sessionId).set(filepath, stat(filepath));
}

function assert(sessionId: string, filepath: string): void {
	const stamp = sessions.get(sessionId)?.get(filepath);
	if (!stamp) {
		throw new Error(`You must read file ${filepath} before editing it. Use the read_file tool first.`);
	}

	const current = stat(filepath);
	const changed = current.mtime !== stamp.mtime || current.ctime !== stamp.ctime || current.size !== stamp.size;

	if (changed) {
		throw new Error(`File ${filepath} has been modified since it was last read. Please read the file again before editing it.`);
	}
}

function invalidate(sessionId: string, filepath: string): void {
	sessions.get(sessionId)?.delete(filepath);
}

function clearSession(sessionId: string): void {
	sessions.delete(sessionId);
}

export const FileTime = { read, assert, invalidate, clearSession };
