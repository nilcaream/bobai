import type { Message } from "../provider/provider";

export interface CompactionSnapshot {
	/** The compacted messages (frozen prefix) */
	compactedMessages: Message[];
	/** Number of raw messages that were compacted into the snapshot */
	rawMessageCount: number;
	/** Total chars of the compacted snapshot */
	snapshotChars: number;
}

const cache = new Map<string, CompactionSnapshot>();

export function getSnapshot(sessionId: string): CompactionSnapshot | undefined {
	return cache.get(sessionId);
}

export function setSnapshot(sessionId: string, snapshot: CompactionSnapshot): void {
	cache.set(sessionId, snapshot);
}

export function clearSnapshot(sessionId: string): void {
	cache.delete(sessionId);
}

/** For testing only */
export function clearAllSnapshots(): void {
	cache.clear();
}
