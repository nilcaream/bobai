import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";

describe("COMPACTION_MARKER", () => {
	test("equals '# COMPACTED'", () => {
		expect(COMPACTION_MARKER).toBe("# COMPACTED");
	});
});
