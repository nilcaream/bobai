import fs from "node:fs";

interface Stamp {
	readonly mtime: number | undefined;
	readonly ctime: number | undefined;
	readonly size: number | undefined;
	/** Wall-clock time (ms) when this file was read into the conversation. */
	readonly readAt: number;
}

function stat(filepath: string): Stamp {
	try {
		const s = fs.statSync(filepath);
		return {
			mtime: s.mtimeMs,
			ctime: s.ctimeMs,
			size: s.size,
			readAt: Date.now(),
		};
	} catch {
		return { mtime: undefined, ctime: undefined, size: undefined, readAt: Date.now() };
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

/** Minimum age (ms) before a read stamp can be invalidated by compaction.
 *  Files read within this window are still in the active conversation and
 *  their content has not been compacted away — safe to keep the stamp. */
const INVALIDATION_GRACE_PERIOD_MS = 60_000;

function invalidate(sessionId: string, filepath: string): void {
	const stamp = sessions.get(sessionId)?.get(filepath);
	if (stamp && Date.now() - stamp.readAt < INVALIDATION_GRACE_PERIOD_MS) {
		return; // recently read — content is still in the conversation
	}
	sessions.get(sessionId)?.delete(filepath);
}

function clearSession(sessionId: string): void {
	sessions.delete(sessionId);
}

export const FileTime = { read, assert, invalidate, clearSession };
