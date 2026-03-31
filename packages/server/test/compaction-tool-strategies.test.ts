import { describe, expect, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import type { SkillRegistry } from "../src/skill/skill";
import { bashTool } from "../src/tool/bash";
import { editFileTool } from "../src/tool/edit-file";
import { fileSearchTool } from "../src/tool/file-search";
import { grepSearchTool } from "../src/tool/grep-search";
import { listDirectoryTool } from "../src/tool/list-directory";
import { readFileTool } from "../src/tool/read-file";
import { createSkillTool } from "../src/tool/skill";
import { createTaskTool } from "../src/tool/task";
import { writeFileTool } from "../src/tool/write-file";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

function makeSkillTool() {
	const registry: SkillRegistry = {
		get: (name) =>
			name === "tdd"
				? { name: "tdd", description: "TDD skill", content: "# TDD\nWrite tests first.", filePath: "/skills/tdd/SKILL.md" }
				: undefined,
		list: () => [
			{ name: "tdd", description: "TDD skill", content: "# TDD\nWrite tests first.", filePath: "/skills/tdd/SKILL.md" },
		],
	};
	return createSkillTool(registry);
}

function makeTaskTool() {
	return createTaskTool({
		configDir: "/tmp/fake",
		session: { id: "s1", modelId: "test", title: "", createdAt: Date.now(), promptTokens: 0 },
		agentLoop: async () => ({ messages: [], interrupt: false }),
		loadTools: async () => ({}),
	});
}

// ---------------------------------------------------------------------------
// Resistance values
// ---------------------------------------------------------------------------

describe("compactionResistance values", () => {
	test("file_search has resistance 0.1", () => {
		expect(fileSearchTool.compactionResistance).toBe(0.1);
	});

	test("grep_search has resistance 0.2", () => {
		expect(grepSearchTool.compactionResistance).toBe(0.2);
	});

	test("skill has resistance 0.2", () => {
		expect(makeSkillTool().compactionResistance).toBe(0.2);
	});

	test("read_file has resistance 0.4", () => {
		expect(readFileTool.compactionResistance).toBe(0.4);
	});

	test("bash has resistance 0.5", () => {
		expect(bashTool.compactionResistance).toBe(0.5);
	});

	test("list_directory has resistance 0.1", () => {
		expect(listDirectoryTool.compactionResistance).toBe(0.1);
	});

	test("write_file has resistance 0.7", () => {
		expect(writeFileTool.compactionResistance).toBe(0.7);
	});

	test("edit_file has resistance 0.8", () => {
		expect(editFileTool.compactionResistance).toBe(0.8);
	});

	test("task has resistance 1.0", () => {
		expect(makeTaskTool().compactionResistance).toBe(1.0);
	});
});

// ---------------------------------------------------------------------------
// Tools WITHOUT custom compact() use default fallback
// ---------------------------------------------------------------------------

describe("tools without custom compact()", () => {
	test("list_directory has no compact method", () => {
		expect(listDirectoryTool.compact).toBeUndefined();
	});

	test("write_file has no compact method", () => {
		expect(writeFileTool.compact).toBeUndefined();
	});

	test("edit_file has no compact method", () => {
		expect(editFileTool.compact).toBeUndefined();
	});

	test("task has no compact method", () => {
		expect(makeTaskTool().compact).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// file_search compact()
// ---------------------------------------------------------------------------

describe("file_search compact()", () => {
	if (!fileSearchTool.compact) throw new Error("expected compact on file_search");
	const compact = fileSearchTool.compact;

	test("preserves error messages", () => {
		const output = "Error: invalid glob pattern";
		expect(compact(output, 0.8, { pattern: "*.ts" })).toBe(output);
	});

	test("preserves 'No files found' messages", () => {
		const output = "No files found matching *.xyz";
		expect(compact(output, 0.8, { pattern: "*.xyz" })).toBe(output);
	});

	test("preserves short output (3 or fewer paths)", () => {
		const output = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
		expect(compact(output, 0.8, { pattern: "*.ts" })).toBe(output);
	});

	test("does not compact when keepCount >= total", () => {
		const paths = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`).join("\n");
		// strength 0.1 → keepCount = floor(5 * 0.9) = 4, still < 5 so compacts
		// strength 0 → keepCount = floor(5 * 1) = 5 >= 5, no compaction
		expect(compact(paths, 0, { pattern: "*.ts" })).toBe(paths);
	});

	test("compacts long file list at high strength", () => {
		const paths = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
		const output = paths.join("\n");
		const result = compact(output, 0.8, { pattern: "*.ts" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("file_search('*.ts')");
		expect(result).toContain("found 20 files");
		// At strength 0.8 → keepCount = max(3, floor(20*0.199…)) = 3 (floating-point: 1-0.8 ≈ 0.1999…)
		expect(result).toContain("showing first 3");
		// First 3 paths should be present
		expect(result).toContain("src/file0.ts");
		expect(result).toContain("src/file2.ts");
		// Later paths should not
		expect(result).not.toContain("src/file19.ts");
	});

	test("filters out '(Results capped' lines when counting", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
		paths.push("(Results capped at 10)");
		const output = paths.join("\n");
		const result = compact(output, 0.8, { pattern: "*.ts" });

		// Total file paths is 10 (the capped line is excluded)
		expect(result).toContain("found 10 files");
		// The capped line should NOT appear in compacted output
		expect(result).not.toContain("(Results capped");
	});

	test("uses '?' for missing pattern arg", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`).join("\n");
		const result = compact(paths, 0.8, {});
		expect(result).toContain("file_search('?')");
	});

	test("respects minimum keepCount of 3", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`).join("\n");
		// strength 0.99 → keepCount = max(3, floor(10*0.01)) = max(3,0) = 3
		const result = compact(paths, 0.99, { pattern: "*.ts" });
		expect(result).toContain("showing first 3");
	});
});

// ---------------------------------------------------------------------------
// grep_search compact()
// ---------------------------------------------------------------------------

describe("grep_search compact()", () => {
	if (!grepSearchTool.compact) throw new Error("expected compact on grep_search");
	const compact = grepSearchTool.compact;

	test("preserves 'No matches found.' exactly", () => {
		expect(compact("No matches found.", 0.8, { pattern: "foo" })).toBe("No matches found.");
	});

	test("preserves error messages", () => {
		const output = "Error: invalid regex";
		expect(compact(output, 0.8, { pattern: "[bad" })).toBe(output);
	});

	test("preserves short output (3 or fewer lines)", () => {
		const output = "src/a.ts:10: match1\nsrc/b.ts:20: match2";
		expect(compact(output, 0.8, { pattern: "foo" })).toBe(output);
	});

	test("compacts long match list at high strength", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`);
		const output = lines.join("\n");
		const result = compact(output, 0.8, { pattern: "match" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("grep_search('match')");
		expect(result).toContain("found 20 matches");
		// strength 0.8 → keepCount = max(3, floor(20*0.199…)) = 3 (floating-point)
		expect(result).toContain("showing first 3");
	});

	test("filters out '... truncated' lines", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`);
		lines.push("... truncated 50 more matches");
		const output = lines.join("\n");
		const result = compact(output, 0.8, { pattern: "test" });

		// Total should be 10 (truncated line excluded)
		expect(result).toContain("found 10 matches");
		expect(result).not.toContain("... truncated");
	});

	test("uses '?' for missing pattern arg", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:1: hit`).join("\n");
		const result = compact(lines, 0.8, {});
		expect(result).toContain("grep_search('?')");
	});
});

// ---------------------------------------------------------------------------
// skill compact()
// ---------------------------------------------------------------------------

describe("skill compact()", () => {
	const tool = makeSkillTool();
	if (!tool.compact) throw new Error("expected compact on skill");
	const compact = tool.compact;

	test("always produces COMPACTED marker regardless of strength", () => {
		const output = "# TDD\n\nWrite tests first.\n\nLong content here...";
		expect(compact(output, 0.0, { name: "tdd" })).toContain(COMPACTION_MARKER);
		expect(compact(output, 0.5, { name: "tdd" })).toContain(COMPACTION_MARKER);
		expect(compact(output, 1.0, { name: "tdd" })).toContain(COMPACTION_MARKER);
	});

	test("includes skill name in compacted output", () => {
		const result = compact("anything", 0.5, { name: "tdd" });
		expect(result).toContain("skill 'tdd'");
		expect(result).toContain("was loaded and applied");
	});

	test("includes re-invoke hint", () => {
		const result = compact("anything", 0.5, { name: "debugging" });
		expect(result).toContain("Re-invoke with skill('debugging')");
	});

	test("uses 'unknown' for missing name arg", () => {
		const result = compact("content", 0.5, {});
		expect(result).toContain("skill 'unknown'");
	});

	test("completely replaces original output", () => {
		const original = "# Very Long Skill Content\n".repeat(100);
		const result = compact(original, 0.5, { name: "tdd" });
		expect(result).not.toContain("Very Long Skill Content");
		expect(result.split("\n").length).toBe(1); // single line
	});
});

// ---------------------------------------------------------------------------
// read_file compact()
// ---------------------------------------------------------------------------

describe("read_file compact()", () => {
	if (!readFileTool.compact) throw new Error("expected compact on read_file");
	const compact = readFileTool.compact;

	test("preserves error messages", () => {
		const output = "Error: file not found";
		expect(compact(output, 0.8, { path: "/foo.ts" })).toBe(output);
	});

	test("preserves short output (6 lines or fewer)", () => {
		const output = makeLines(6);
		expect(compact(output, 0.8, { path: "/foo.ts" })).toBe(output);
	});

	test("does not compact when keepPerSide * 2 >= total", () => {
		// 7 lines, strength 0.1 → keepPerSide = max(3, floor(7*0.9/2)) = max(3,3) = 3, 3*2=6 < 7, compacts
		// 7 lines, strength 0.0 → keepPerSide = max(3, floor(7*1.0/2)) = max(3,3) = 3, 3*2=6 < 7, compacts
		// Use a case where it won't compact:
		const _output = makeLines(7);
		// strength 0 with 7 lines → keepPerSide = max(3, floor(7/2)) = max(3,3)=3, 6 < 7 → still compacts!
		// Actually we need keepPerSide*2 >= total: e.g. 6 lines, strength anything → total <= 6 returns early
		// For 8 lines: keepPerSide = max(3, floor(8*1.0/2))=4, 8 >= 8 → no compaction
		const output8 = makeLines(8);
		expect(compact(output8, 0, { path: "/foo.ts" })).toBe(output8);
	});

	test("produces head + COMPACTED + tail at high strength", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}: content line ${i + 1}`);
		const output = lines.join("\n");
		const result = compact(output, 0.8, { path: "/src/foo.ts" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("read_file('/src/foo.ts')");
		expect(result).toContain("omitted");
		// strength 0.8 → keepPerSide = max(3, floor(20*0.2/2)) = max(3,2) = 3
		// head: first 3 lines, tail: last 3 lines, removed: 20-6 = 14
		expect(result).toContain("14 lines");
		// Verify head lines present
		expect(result).toContain("1: content line 1");
		expect(result).toContain("3: content line 3");
		// Verify tail lines present
		expect(result).toContain("20: content line 20");
		expect(result).toContain("18: content line 18");
		// Middle lines absent
		expect(result).not.toContain("10: content line 10");
	});

	test("uses 'unknown' for missing path arg", () => {
		const output = makeLines(20);
		const result = compact(output, 0.8, {});
		expect(result).toContain("read_file('unknown')");
	});
});

// ---------------------------------------------------------------------------
// bash compact()
// ---------------------------------------------------------------------------

describe("bash compact()", () => {
	if (!bashTool.compact) throw new Error("expected compact on bash");
	const compact = bashTool.compact;

	test("preserves error messages", () => {
		const output = "Error: command not found";
		expect(compact(output, 0.8, { command: "foobar" })).toBe(output);
	});

	test("preserves short output (6 lines or fewer)", () => {
		const output = makeLines(6);
		expect(compact(output, 0.8, { command: "ls" })).toBe(output);
	});

	test("produces head + COMPACTED + tail for long output", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`);
		const output = lines.join("\n");
		const result = compact(output, 0.8, { command: "npm test" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("bash('npm test')");
		expect(result).toContain("omitted");
		// First lines present
		expect(result).toContain("output line 1");
		// Last lines present
		expect(result).toContain("output line 30");
		// Middle absent
		expect(result).not.toContain("output line 15");
	});

	test("preserves 'exit code:' trailer", () => {
		const contentLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const output = [...contentLines, "exit code: 1"].join("\n");
		const result = compact(output, 0.8, { command: "make" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("exit code: 1");
		// Exit code should be the very last line
		const resultLines = result.split("\n");
		expect(resultLines[resultLines.length - 1]).toBe("exit code: 1");
	});

	test("preserves 'Command timed out' trailer", () => {
		const contentLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const output = [...contentLines, "Command timed out after 30s"].join("\n");
		const result = compact(output, 0.8, { command: "sleep 100" });

		expect(result).toContain("Command timed out after 30s");
		const resultLines = result.split("\n");
		expect(resultLines[resultLines.length - 1]).toBe("Command timed out after 30s");
	});

	test("handles empty line before exit code trailer", () => {
		const contentLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const output = [...contentLines, "", "exit code: 0"].join("\n");
		const result = compact(output, 0.8, { command: "echo hi" });

		expect(result).toContain("exit code: 0");
		// The empty line before exit code should be stripped from content
		expect(result).toContain(COMPACTION_MARKER);
	});

	test("does not compact when content lines <= 6 after trailer extraction", () => {
		const contentLines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
		const output = [...contentLines, "exit code: 0"].join("\n");
		expect(compact(output, 0.8, { command: "ls" })).toBe(output);
	});

	test("uses '?' for missing command arg", () => {
		const output = makeLines(20);
		const result = compact(output, 0.8, {});
		expect(result).toContain("bash('?')");
	});
});

// ---------------------------------------------------------------------------
// Integration: compact() methods exist on expected tools
// ---------------------------------------------------------------------------

describe("compact() method presence", () => {
	test("file_search has compact()", () => {
		expect(typeof fileSearchTool.compact).toBe("function");
	});

	test("grep_search has compact()", () => {
		expect(typeof grepSearchTool.compact).toBe("function");
	});

	test("skill has compact()", () => {
		expect(typeof makeSkillTool().compact).toBe("function");
	});

	test("read_file has compact()", () => {
		expect(typeof readFileTool.compact).toBe("function");
	});

	test("bash has compact()", () => {
		expect(typeof bashTool.compact).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// edit_file compactArgs()
// ---------------------------------------------------------------------------

describe("edit_file compactArgs()", () => {
	if (!editFileTool.compactArgs) throw new Error("expected compactArgs on edit_file");
	const compactArgs = editFileTool.compactArgs;

	test("replaces old_string and new_string with COMPACTION_MARKER", () => {
		const args = { path: "foo.kt", old_string: "old content here", new_string: "new content here" };
		const result = compactArgs(args, 0.5);
		expect(result.old_string).toBe(COMPACTION_MARKER);
		expect(result.new_string).toBe(COMPACTION_MARKER);
	});

	test("preserves path unchanged", () => {
		const args = { path: "src/main/kotlin/Foo.kt", old_string: "old", new_string: "new" };
		const result = compactArgs(args, 0.5);
		expect(result.path).toBe("src/main/kotlin/Foo.kt");
	});

	test("replaces regardless of strength value", () => {
		const args = { path: "f.ts", old_string: "content", new_string: "content" };
		for (const strength of [0.01, 0.1, 0.5, 0.9, 1.0]) {
			const result = compactArgs(args, strength);
			expect(result.old_string).toBe(COMPACTION_MARKER);
			expect(result.new_string).toBe(COMPACTION_MARKER);
		}
	});

	test("does not mutate the original args object", () => {
		const args = { path: "f.ts", old_string: "old", new_string: "new" };
		const result = compactArgs(args, 0.5);
		expect(result).not.toBe(args);
		expect(args.old_string).toBe("old");
		expect(args.new_string).toBe("new");
	});

	test("handles missing string fields gracefully", () => {
		const args = { path: "f.ts" };
		const result = compactArgs(args, 0.5);
		expect(result.path).toBe("f.ts");
		expect(result.old_string).toBeUndefined();
		expect(result.new_string).toBeUndefined();
	});
});
