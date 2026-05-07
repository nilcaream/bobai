import { beforeEach, describe, expect, test } from "bun:test";
import { type CompactionSnapshot, clearAllSnapshots, clearSnapshot, getSnapshot, setSnapshot } from "../src/compaction/cache";

describe("compaction cache", () => {
	beforeEach(() => {
		clearAllSnapshots();
	});

	test("returns undefined for unknown session", () => {
		expect(getSnapshot("unknown")).toBeUndefined();
	});

	test("stores and retrieves snapshot", () => {
		const snapshot: CompactionSnapshot = {
			compactedMessages: [{ role: "user", content: "hello" }],
			rawMessageCount: 5,
			snapshotChars: 5,
		};
		setSnapshot("sess1", snapshot);
		expect(getSnapshot("sess1")).toBe(snapshot);
	});

	test("clearSnapshot removes specific session", () => {
		setSnapshot("sess1", { compactedMessages: [], rawMessageCount: 0, snapshotChars: 0 });
		setSnapshot("sess2", { compactedMessages: [], rawMessageCount: 0, snapshotChars: 0 });
		clearSnapshot("sess1");
		expect(getSnapshot("sess1")).toBeUndefined();
		expect(getSnapshot("sess2")).toBeDefined();
	});

	test("clearAllSnapshots removes everything", () => {
		setSnapshot("sess1", { compactedMessages: [], rawMessageCount: 0, snapshotChars: 0 });
		setSnapshot("sess2", { compactedMessages: [], rawMessageCount: 0, snapshotChars: 0 });
		clearAllSnapshots();
		expect(getSnapshot("sess1")).toBeUndefined();
		expect(getSnapshot("sess2")).toBeUndefined();
	});
});
