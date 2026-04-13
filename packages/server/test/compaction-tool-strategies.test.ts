import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import type { SkillRegistry } from "../src/skill/skill";
import { bashTool } from "../src/tool/bash";
import { editFileTool } from "../src/tool/edit-file";
import { fileSearchTool } from "../src/tool/file-search";
import { grepSearchTool } from "../src/tool/grep-search";
import { listDirectoryTool } from "../src/tool/list-directory";
import { readFileTool } from "../src/tool/read-file";
import { createSkillTool } from "../src/tool/skill";
import { sqlite3Tool } from "../src/tool/sqlite3";
import { createTaskTool } from "../src/tool/task";
import { writeFileTool } from "../src/tool/write-file";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

/** Assert an optional method exists and return it (avoids non-null assertion lint warnings). */
function requireMethod<T>(val: T | undefined, name: string): T {
	if (val === undefined) throw new Error(`expected ${name} to be defined`);
	return val;
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

/**
 * Construct a task tool with minimal mocked deps.
 * compact() and compactArgs() are pure functions that don't use deps,
 * so we only need to satisfy the constructor shape.
 */
function makeTaskTool() {
	// biome-ignore lint/suspicious/noExplicitAny: minimal mock deps for testing pure compact methods
	const deps: any = {
		db: {},
		provider: {},
		model: "test",
		parentSessionId: "test-parent",
		projectRoot: process.cwd(),
		systemPrompt: "test",
		onEvent: () => {},
		subagentStatus: { set: () => {}, get: () => undefined, getAll: () => ({}) },
	};
	return createTaskTool(deps);
}

// ---------------------------------------------------------------------------
// Threshold values
// ---------------------------------------------------------------------------

describe("threshold values", () => {
	test("bash: outputThreshold = 0.4", () => {
		expect(bashTool.outputThreshold).toBe(0.4);
		expect(bashTool.argsThreshold).toBeUndefined();
	});

	test("read_file: outputThreshold = 0.3", () => {
		expect(readFileTool.outputThreshold).toBe(0.3);
		expect(readFileTool.argsThreshold).toBeUndefined();
	});

	test("grep_search: outputThreshold = 0.29", () => {
		expect(grepSearchTool.outputThreshold).toBe(0.29);
		expect(grepSearchTool.argsThreshold).toBeUndefined();
	});

	test("file_search: outputThreshold = 0.27", () => {
		expect(fileSearchTool.outputThreshold).toBe(0.27);
		expect(fileSearchTool.argsThreshold).toBeUndefined();
	});

	test("list_directory: outputThreshold = 0.25", () => {
		expect(listDirectoryTool.outputThreshold).toBe(0.25);
		expect(listDirectoryTool.argsThreshold).toBeUndefined();
	});

	test("skill: outputThreshold = 0.46", () => {
		expect(makeSkillTool().outputThreshold).toBe(0.46);
		expect(makeSkillTool().argsThreshold).toBeUndefined();
	});

	test("sqlite3: outputThreshold = 0.43", () => {
		expect(sqlite3Tool.outputThreshold).toBe(0.43);
		expect(sqlite3Tool.argsThreshold).toBeUndefined();
	});

	test("write_file: argsThreshold = 0.50, no outputThreshold", () => {
		expect(writeFileTool.argsThreshold).toBe(0.5);
		expect(writeFileTool.outputThreshold).toBeUndefined();
	});

	test("edit_file: outputThreshold = 0.55, argsThreshold = 0.35", () => {
		expect(editFileTool.outputThreshold).toBe(0.55);
		expect(editFileTool.argsThreshold).toBe(0.35);
	});

	test("task: outputThreshold = 0.70, argsThreshold = 0.62", () => {
		const tool = makeTaskTool();
		expect(tool.outputThreshold).toBe(0.7);
		expect(tool.argsThreshold).toBe(0.62);
	});
});

// ---------------------------------------------------------------------------
// compact() method presence
// ---------------------------------------------------------------------------

describe("compact() method presence", () => {
	test("bash has compact()", () => {
		expect(typeof bashTool.compact).toBe("function");
	});

	test("read_file has compact()", () => {
		expect(typeof readFileTool.compact).toBe("function");
	});

	test("grep_search has compact()", () => {
		expect(typeof grepSearchTool.compact).toBe("function");
	});

	test("file_search has compact()", () => {
		expect(typeof fileSearchTool.compact).toBe("function");
	});

	test("list_directory has compact()", () => {
		expect(typeof listDirectoryTool.compact).toBe("function");
	});

	test("skill has compact()", () => {
		expect(typeof makeSkillTool().compact).toBe("function");
	});

	test("edit_file has compact()", () => {
		expect(typeof editFileTool.compact).toBe("function");
	});

	test("sqlite3 has compact()", () => {
		expect(typeof sqlite3Tool.compact).toBe("function");
	});

	test("task has compact()", () => {
		expect(typeof makeTaskTool().compact).toBe("function");
	});

	test("write_file has NO compact()", () => {
		expect(writeFileTool.compact).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// compactArgs() method presence
// ---------------------------------------------------------------------------

describe("compactArgs() method presence", () => {
	test("write_file has compactArgs()", () => {
		expect(typeof writeFileTool.compactArgs).toBe("function");
	});

	test("edit_file has compactArgs()", () => {
		expect(typeof editFileTool.compactArgs).toBe("function");
	});

	test("task has compactArgs()", () => {
		expect(typeof makeTaskTool().compactArgs).toBe("function");
	});

	test("bash has NO compactArgs()", () => {
		expect(bashTool.compactArgs).toBeUndefined();
	});

	test("read_file has NO compactArgs()", () => {
		expect(readFileTool.compactArgs).toBeUndefined();
	});

	test("grep_search has NO compactArgs()", () => {
		expect(grepSearchTool.compactArgs).toBeUndefined();
	});

	test("file_search has NO compactArgs()", () => {
		expect(fileSearchTool.compactArgs).toBeUndefined();
	});

	test("list_directory has NO compactArgs()", () => {
		expect(listDirectoryTool.compactArgs).toBeUndefined();
	});

	test("sqlite3 has NO compactArgs()", () => {
		expect(sqlite3Tool.compactArgs).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// bash compact()
// ---------------------------------------------------------------------------

describe("bash compact()", () => {
	const compact = requireMethod(bashTool.compact, "bash.compact");

	test("preserves error messages", () => {
		const output = "Error: command not found";
		expect(compact(output, { command: "foobar" })).toBe(output);
	});

	test("preserves short output (10 lines or fewer)", () => {
		const output = makeLines(10);
		expect(compact(output, { command: "ls" })).toBe(output);
	});

	test("compacts output longer than 10 lines — tail only", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`);
		const output = lines.join("\n");
		const result = compact(output, { command: "npm test" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('bash({"command":"npm test"})');
		expect(result).toContain("20 lines");
		expect(result).toContain("omitted");
		// Tail: last 10 lines kept
		expect(result).toContain("output line 21");
		expect(result).toContain("output line 30");
		// Head absent
		expect(result).not.toContain("output line 1\n");
	});

	test("exit code is kept in tail naturally", () => {
		const contentLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const output = [...contentLines, "", "exit code: 1"].join("\n");
		const result = compact(output, { command: "make" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("exit code: 1");
	});

	test("uses '?' for missing command arg", () => {
		const output = makeLines(20);
		const result = compact(output, {});
		expect(result).toContain('bash({"command":"?"})');
	});

	test("includes command as JSON in marker", () => {
		const output = makeLines(20);
		const result = compact(output, { command: 'echo "hello world"' });
		expect(result).toContain(JSON.stringify({ command: 'echo "hello world"' }));
	});
});

// ---------------------------------------------------------------------------
// read_file compact()
// ---------------------------------------------------------------------------

describe("read_file compact()", () => {
	const compact = requireMethod(readFileTool.compact, "readFileTool.compact");

	test("preserves error messages", () => {
		const output = "Error: file not found";
		expect(compact(output, { path: "/foo.ts" })).toBe(output);
	});

	test("preserves short output (6 lines or fewer)", () => {
		const output = makeLines(6);
		expect(compact(output, { path: "/foo.ts" })).toBe(output);
	});

	test("compacts output with head(3) + marker + tail(3)", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}: content line ${i + 1}`);
		const output = lines.join("\n");
		const result = compact(output, { path: "src/foo.ts" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('read_file({"path":"src/foo.ts"})');
		expect(result).toContain("14 lines");
		expect(result).toContain("omitted. Re-read to see full content.");
		// Head: first 3 lines
		expect(result).toContain("1: content line 1");
		expect(result).toContain("3: content line 3");
		// Tail: last 3 lines
		expect(result).toContain("20: content line 20");
		expect(result).toContain("18: content line 18");
		// Middle absent
		expect(result).not.toContain("10: content line 10");
	});

	test("includes from/to in marker args when present", () => {
		const output = makeLines(20);
		const result = compact(output, { path: "foo.ts", from: 10, to: 30 });
		expect(result).toContain('"from":10');
		expect(result).toContain('"to":30');
	});

	test("omits from/to from marker args when absent", () => {
		const output = makeLines(20);
		const result = compact(output, { path: "foo.ts" });
		expect(result).not.toContain('"from"');
		expect(result).not.toContain('"to"');
	});
});

// ---------------------------------------------------------------------------
// grep_search compact()
// ---------------------------------------------------------------------------

describe("grep_search compact()", () => {
	const compact = requireMethod(grepSearchTool.compact, "grepSearchTool.compact");

	test("preserves 'No matches found.'", () => {
		expect(compact("No matches found.", { pattern: "foo" })).toBe("No matches found.");
	});

	test("preserves error messages", () => {
		const output = "Error: invalid regex";
		expect(compact(output, { pattern: "[bad" })).toBe(output);
	});

	test("preserves short output (5 or fewer match lines)", () => {
		const output = "src/a.ts:10: match1\nsrc/b.ts:20: match2";
		expect(compact(output, { pattern: "foo" })).toBe(output);
	});

	test("compacts to first 5 matches for longer output", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`);
		const output = lines.join("\n");
		const result = compact(output, { pattern: "match" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('grep_search({"pattern":"match"})');
		expect(result).toContain("found 20 matches");
		expect(result).toContain("showing first 5");
		// First 5 present
		expect(result).toContain("src/file0.ts");
		expect(result).toContain("src/file4.ts");
		// 6th and beyond absent
		expect(result).not.toContain("src/file5.ts");
	});

	test("includes path and include in marker args when present", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:1: hit`);
		const result = compact(lines.join("\n"), { pattern: "hit", path: "src", include: "*.ts" });
		expect(result).toContain('"path":"src"');
		expect(result).toContain('"include":"*.ts"');
	});

	test("omits path/include from marker args when absent", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:1: hit`);
		const result = compact(lines.join("\n"), { pattern: "hit" });
		expect(result).not.toContain('"path"');
		expect(result).not.toContain('"include"');
	});

	test("filters out '... truncated' lines", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`);
		lines.push("... truncated 50 more matches");
		const output = lines.join("\n");
		const result = compact(output, { pattern: "test" });

		expect(result).toContain("found 10 matches");
		expect(result).not.toContain("... truncated");
	});
});

// ---------------------------------------------------------------------------
// file_search compact()
// ---------------------------------------------------------------------------

describe("file_search compact()", () => {
	const compact = requireMethod(fileSearchTool.compact, "fileSearchTool.compact");

	test("preserves error messages", () => {
		const output = "Error: invalid glob pattern";
		expect(compact(output, { pattern: "*.ts" })).toBe(output);
	});

	test("preserves 'No files found' messages", () => {
		const output = 'No files found matching "*.xyz"';
		expect(compact(output, { pattern: "*.xyz" })).toBe(output);
	});

	test("preserves short output (5 or fewer paths)", () => {
		const output = "src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\nsrc/e.ts";
		expect(compact(output, { pattern: "*.ts" })).toBe(output);
	});

	test("compacts to first 5 files for longer output", () => {
		const paths = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
		const output = paths.join("\n");
		const result = compact(output, { pattern: "*.ts" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('file_search({"pattern":"*.ts"})');
		expect(result).toContain("found 20 files");
		expect(result).toContain("showing first 5");
		// First 5 present
		expect(result).toContain("src/file0.ts");
		expect(result).toContain("src/file4.ts");
		// 6th and beyond absent
		expect(result).not.toContain("src/file5.ts");
	});

	test("includes path in marker args when present", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
		const result = compact(paths.join("\n"), { pattern: "*.ts", path: "src" });
		expect(result).toContain('"path":"src"');
	});

	test("omits path from marker args when absent", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
		const result = compact(paths.join("\n"), { pattern: "*.ts" });
		expect(result).not.toContain('"path"');
	});

	test("filters out '(Results capped' lines when counting", () => {
		const paths = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
		paths.push("(Results capped at 10)");
		const output = paths.join("\n");
		const result = compact(output, { pattern: "*.ts" });

		expect(result).toContain("found 10 files");
		expect(result).not.toContain("(Results capped");
	});
});

// ---------------------------------------------------------------------------
// list_directory compact()
// ---------------------------------------------------------------------------

describe("list_directory compact()", () => {
	const compact = requireMethod(listDirectoryTool.compact, "listDirectoryTool.compact");

	test("preserves error messages", () => {
		const output = "Error: directory not found";
		expect(compact(output, { path: "/bad" })).toBe(output);
	});

	test("preserves short output (5 or fewer entries)", () => {
		const output = "src/\nREADME.md\npackage.json\ntsconfig.json\n.gitignore";
		expect(compact(output, { path: "." })).toBe(output);
	});

	test("compacts to first 5 entries for longer output", () => {
		const entries = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
		const output = entries.join("\n");
		const result = compact(output, { path: "src" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('list_directory({"path":"src"})');
		expect(result).toContain("showed 15 entries");
		expect(result).toContain("showing first 5");
		// First 5 present
		expect(result).toContain("file0.ts");
		expect(result).toContain("file4.ts");
		// 6th and beyond absent
		expect(result).not.toContain("file5.ts");
	});

	test("uses '.' when path is not provided", () => {
		const entries = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
		const result = compact(entries.join("\n"), {});
		expect(result).toContain('"path":"."');
	});
});

// ---------------------------------------------------------------------------
// skill compact()
// ---------------------------------------------------------------------------

describe("skill compact()", () => {
	const tool = makeSkillTool();
	const compact = requireMethod(tool.compact, "tool.compact");

	test("always produces COMPACTED marker", () => {
		const output = "# TDD\n\nWrite tests first.\n\nLong content here...";
		expect(compact(output, { name: "tdd" })).toContain(COMPACTION_MARKER);
	});

	test("includes skill name as JSON in marker", () => {
		const result = compact("anything", { name: "tdd" });
		expect(result).toContain('skill({"name":"tdd"})');
		expect(result).toContain("was loaded and applied");
	});

	test("includes re-invoke hint", () => {
		const result = compact("anything", { name: "debugging" });
		expect(result).toContain("Re-invoke if needed");
	});

	test("uses 'unknown' for missing name arg", () => {
		const result = compact("content", {});
		expect(result).toContain('"name":"unknown"');
	});

	test("completely replaces original output", () => {
		const original = "# Very Long Skill Content\n".repeat(100);
		const result = compact(original, { name: "tdd" });
		expect(result).not.toContain("Very Long Skill Content");
		expect(result.split("\n").length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// edit_file compact()
// ---------------------------------------------------------------------------

describe("edit_file compact()", () => {
	const compact = requireMethod(editFileTool.compact, "editFileTool.compact");

	test("preserves error messages", () => {
		const output = "Error: old_string not found";
		expect(compact(output, { path: "foo.ts" })).toBe(output);
	});

	test("preserves short output (6 lines or fewer)", () => {
		const output = makeLines(6);
		expect(compact(output, { path: "foo.ts" })).toBe(output);
	});

	test("compacts output with head(3) + marker + tail(3)", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}: edited content ${i + 1}`);
		const output = lines.join("\n");
		const result = compact(output, { path: "src/main.ts" });

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('edit_file({"path":"src/main.ts"})');
		expect(result).toContain("14 lines");
		expect(result).toContain("output omitted. Re-read the file to see current content.");
		// Head: first 3 lines
		expect(result).toContain("1: edited content 1");
		expect(result).toContain("3: edited content 3");
		// Tail: last 3 lines
		expect(result).toContain("20: edited content 20");
		expect(result).toContain("18: edited content 18");
		// Middle absent
		expect(result).not.toContain("10: edited content 10");
	});
});

// ---------------------------------------------------------------------------
// edit_file compactArgs()
// ---------------------------------------------------------------------------

describe("edit_file compactArgs()", () => {
	const compactArgs = requireMethod(editFileTool.compactArgs, "editFileTool.compactArgs");

	test("replaces old_string and new_string with COMPACTION_MARKER", () => {
		const args = { path: "foo.kt", old_string: "old content here", new_string: "new content here" };
		const result = compactArgs(args);
		expect(result.old_string).toBe(COMPACTION_MARKER);
		expect(result.new_string).toBe(COMPACTION_MARKER);
	});

	test("preserves path unchanged", () => {
		const args = { path: "src/main/kotlin/Foo.kt", old_string: "old", new_string: "new" };
		const result = compactArgs(args);
		expect(result.path).toBe("src/main/kotlin/Foo.kt");
	});

	test("does not mutate the original args object", () => {
		const args = { path: "f.ts", old_string: "old", new_string: "new" };
		const result = compactArgs(args);
		expect(result).not.toBe(args);
		expect(args.old_string).toBe("old");
		expect(args.new_string).toBe("new");
	});

	test("handles missing string fields gracefully", () => {
		const args = { path: "f.ts" };
		const result = compactArgs(args);
		expect(result.path).toBe("f.ts");
		expect(result.old_string).toBeUndefined();
		expect(result.new_string).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// write_file compactArgs()
// ---------------------------------------------------------------------------

describe("write_file compactArgs()", () => {
	const compactArgs = requireMethod(writeFileTool.compactArgs, "writeFileTool.compactArgs");

	test("replaces content with COMPACTION_MARKER", () => {
		const args = { path: "out.txt", content: "lots of file content here" };
		const result = compactArgs(args);
		expect(result.content).toBe(COMPACTION_MARKER);
	});

	test("preserves path unchanged", () => {
		const args = { path: "src/index.ts", content: "export default 42;" };
		const result = compactArgs(args);
		expect(result.path).toBe("src/index.ts");
	});

	test("does not mutate the original args object", () => {
		const args = { path: "f.ts", content: "hello" };
		const result = compactArgs(args);
		expect(result).not.toBe(args);
		expect(args.content).toBe("hello");
	});

	test("handles missing content field gracefully", () => {
		const args = { path: "f.ts" };
		const result = compactArgs(args);
		expect(result.path).toBe("f.ts");
		expect(result.content).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// task compact() and compactArgs()
// ---------------------------------------------------------------------------

describe("task compact()", () => {
	let tempDir: string | null = null;

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		tempDir = null;
	});

	test("compact() without context uses <unknown> path", () => {
		const tool = makeTaskTool();
		const compact = requireMethod(tool.compact, "tool.compact");
		const result = compact("long subagent output here", { description: "Run tests" }, undefined);

		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('task({"description":"Run tests"})');
		expect(result).toContain(".bobai/compaction/<unknown>.md");
		expect(result).toContain("use read_file to see full result");
	});

	test("compact() with context writes file and uses correct path", () => {
		const tool = makeTaskTool();
		const compact = requireMethod(tool.compact, "tool.compact");
		const sessionId = "test-session-abc";
		const toolCallId = "call-xyz-123";
		const originalOutput = "This is the full subagent output\nWith multiple lines\nOf content.";

		const result = compact(originalOutput, { description: "Deploy app" }, { sessionId, toolCallId });

		// Verify marker text
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain('task({"description":"Deploy app"})');
		expect(result).toContain(`.bobai/compaction/${sessionId}/${toolCallId}.md`);

		// Verify file was actually written
		const filePath = path.join(".bobai", "compaction", sessionId, `${toolCallId}.md`);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(originalOutput);

		// Cleanup
		tempDir = path.join(".bobai", "compaction", sessionId);
	});

	test("compact() uses '?' for missing description", () => {
		const tool = makeTaskTool();
		const compact = requireMethod(tool.compact, "tool.compact");
		const result = compact("output", {}, undefined);
		expect(result).toContain('task({"description":"?"})');
	});
});

describe("task compactArgs()", () => {
	test("replaces prompt with COMPACTION_MARKER", () => {
		const tool = makeTaskTool();
		const compactArgs = requireMethod(tool.compactArgs, "tool.compactArgs");
		const args = { description: "Run tests", prompt: "Please run all unit tests and report results" };
		const result = compactArgs(args);

		expect(result.prompt).toBe(COMPACTION_MARKER);
		expect(result.description).toBe("Run tests");
	});

	test("does not mutate original args", () => {
		const tool = makeTaskTool();
		const compactArgs = requireMethod(tool.compactArgs, "tool.compactArgs");
		const args = { description: "Task", prompt: "Do stuff" };
		const result = compactArgs(args);

		expect(result).not.toBe(args);
		expect(args.prompt).toBe("Do stuff");
	});

	test("handles missing prompt gracefully", () => {
		const tool = makeTaskTool();
		const compactArgs = requireMethod(tool.compactArgs, "tool.compactArgs");
		const args = { description: "Task" };
		const result = compactArgs(args);

		expect(result.description).toBe("Task");
		expect(result.prompt).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// sqlite3 compact()
// ---------------------------------------------------------------------------

describe("sqlite3 compact()", () => {
	const compact = requireMethod(sqlite3Tool.compact, "sqlite3.compact");

	test("preserves error messages", () => {
		expect(compact("Error: no such table", { database: "db", query: "q" })).toBe("Error: no such table");
	});

	test("preserves short output (20 lines or fewer)", () => {
		const short = makeLines(20, "| row");
		expect(compact(short, { database: "db", query: "q" })).toBe(short);
	});

	test("compacts output longer than 20 lines — head + tail", () => {
		const lines = makeLines(50, "| row");
		const result = compact(lines, { database: "test.db", query: "SELECT * FROM big" });
		expect(result).toContain(COMPACTION_MARKER);
		expect(result).toContain("30 rows");
		expect(result).toContain("| row 1");
		expect(result).toContain("| row 50");
	});

	test("uses '?' for missing args", () => {
		const lines = makeLines(30, "| row");
		const result = compact(lines, {});
		expect(result).toContain('"database":"?"');
		expect(result).toContain('"query":"?"');
	});
});

// ---------------------------------------------------------------------------
// Old interface fields should NOT exist
// ---------------------------------------------------------------------------

describe("old interface fields removed", () => {
	/** Check a key does NOT exist on a tool object (avoids `as any` lint warnings). */
	function expectNoKey(tool: Record<string, unknown>, key: string) {
		expect(tool[key]).toBeUndefined();
	}

	test("bash has no compactionResistance", () => {
		expectNoKey(bashTool, "compactionResistance");
	});

	test("read_file has no compactionResistance", () => {
		expectNoKey(readFileTool, "compactionResistance");
	});

	test("grep_search has no compactionResistance", () => {
		expectNoKey(grepSearchTool, "compactionResistance");
	});

	test("file_search has no compactionResistance", () => {
		expectNoKey(fileSearchTool, "compactionResistance");
	});

	test("list_directory has no compactionResistance", () => {
		expectNoKey(listDirectoryTool, "compactionResistance");
	});

	test("skill has no compactionResistance", () => {
		expectNoKey(makeSkillTool(), "compactionResistance");
	});

	test("write_file has no compactionResistance or compactableArgs", () => {
		expectNoKey(writeFileTool, "compactionResistance");
		expectNoKey(writeFileTool, "compactableArgs");
	});

	test("edit_file has no compactionResistance or compactableArgs", () => {
		expectNoKey(editFileTool, "compactionResistance");
		expectNoKey(editFileTool, "compactableArgs");
	});

	test("task has no compactionResistance", () => {
		expectNoKey(makeTaskTool(), "compactionResistance");
	});
});
