import { describe, expect, test } from "bun:test";
import { SubagentStatus } from "../src/subagent-status";

describe("SubagentStatus", () => {
	test("set and get status", () => {
		const tracker = new SubagentStatus();
		tracker.set("session-1", "running");
		expect(tracker.get("session-1")).toBe("running");
	});

	test("get returns undefined for unknown session", () => {
		const tracker = new SubagentStatus();
		expect(tracker.get("unknown")).toBeUndefined();
	});

	test("set updates existing status", () => {
		const tracker = new SubagentStatus();
		tracker.set("session-1", "running");
		tracker.set("session-1", "done");
		expect(tracker.get("session-1")).toBe("done");
	});

	test("getAll returns all entries", () => {
		const tracker = new SubagentStatus();
		tracker.set("s1", "running");
		tracker.set("s2", "done");
		const all = tracker.getAll();
		expect(all).toEqual(
			new Map([
				["s1", "running"],
				["s2", "done"],
			]),
		);
	});
});
