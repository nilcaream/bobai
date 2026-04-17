import { describe, expect, test } from "bun:test";
import * as commandParser from "../src/commandParser";

const { FULL_DOT_COMMANDS, parseDotInput, parseSlashInput, STREAMING_DOT_COMMANDS } = commandParser;

describe("parseDotInput", () => {
	test("non-dot input returns null", () => {
		expect(parseDotInput("hello", FULL_DOT_COMMANDS)).toBeNull();
	});

	test("empty dot returns select mode with all commands", () => {
		const result = parseDotInput(".", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		expect(result?.prefix).toBe("");
		expect(result?.matches).toEqual(FULL_DOT_COMMANDS);
	});

	test("partial match returns select mode with filtered commands", () => {
		const result = parseDotInput(".mo", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		expect(result?.prefix).toBe("mo");
		expect(result?.matches).toHaveLength(1);
		expect(result?.matches[0]?.name).toBe("model");
	});

	test("exact single match without space stays in select mode", () => {
		const result = parseDotInput(".model", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		expect(result?.prefix).toBe("model");
		expect(result?.matches).toHaveLength(1);
		expect(result?.matches[0]?.name).toBe("model");
	});

	test("with space and args returns args mode", () => {
		const result = parseDotInput(".model 3", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("args");
		expect(result?.command).toBe("model");
		expect(result?.args).toBe("3");
	});

	test("number shorthand returns args mode", () => {
		const result = parseDotInput(".model3", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("args");
		expect(result?.command).toBe("model");
		expect(result?.args).toBe("3");
	});

	test("new with title returns args mode", () => {
		const result = parseDotInput(".new my title", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("args");
		expect(result?.command).toBe("new");
		expect(result?.args).toBe("my title");
	});

	test("no match returns select mode with empty matches", () => {
		const result = parseDotInput(".xyz", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		expect(result?.prefix).toBe("xyz");
		expect(result?.matches).toHaveLength(0);
	});

	test("ambiguous prefix returns multiple matches", () => {
		const result = parseDotInput(".s", FULL_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		const names = result?.matches.map((m) => m.name);
		expect(names).toContain("session");
		expect(names).toContain("subagent");
		expect(names.length).toBeGreaterThanOrEqual(2);
	});

	test("works with streaming commands", () => {
		const result = parseDotInput(".stop", STREAMING_DOT_COMMANDS);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe("select");
		expect(result?.matches).toHaveLength(1);
		expect(result?.matches[0]?.name).toBe("stop");
	});
});

describe("fuzzy matcher", () => {
	test("exports a shared fuzzy match helper", () => {
		expect(typeof commandParser.fuzzyMatch).toBe("function");
	});

	test("exports a shared fuzzy filter helper", () => {
		expect(typeof commandParser.fuzzyFilterAndSort).toBe("function");
	});

	test("empty query returns 0", () => {
		expect(commandParser.fuzzyMatch("", "anything")).toBe(0);
	});

	test("exact prefix returns 0", () => {
		expect(commandParser.fuzzyMatch("bash", "bash")).toBe(0);
	});

	test("prefix match returns 0", () => {
		expect(commandParser.fuzzyMatch("ba", "bash")).toBe(0);
	});

	test("word boundary match returns a score", () => {
		const score = commandParser.fuzzyMatch("tdd", "test-driven-development");
		expect(score).not.toBeNull();
		expect(typeof score).toBe("number");
	});

	test("no match returns null", () => {
		expect(commandParser.fuzzyMatch("xyz", "bash")).toBeNull();
	});

	test("case insensitive", () => {
		expect(commandParser.fuzzyMatch("BASH", "bash")).toBe(0);
	});

	test("consecutive chars score lower (better) than scattered", () => {
		const consecutive = commandParser.fuzzyMatch("bas", "bash");
		const scattered = commandParser.fuzzyMatch("bsh", "bash");
		expect(consecutive).not.toBeNull();
		expect(scattered).not.toBeNull();
		expect(consecutive as number).toBeLessThan(scattered as number);
	});

	test("word-start match scores better than mid-word match", () => {
		const wordStart = commandParser.fuzzyMatch("td", "test-driven");
		const midWord = commandParser.fuzzyMatch("es", "test-driven");
		expect(wordStart).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(wordStart as number).toBeLessThan(midWord as number);
	});

	test("picker matching treats non-alphanumeric separators as word starts", () => {
		const separatorStart = commandParser.fuzzyMatch("gm", "gpt.5 mini");
		const midWord = commandParser.fuzzyMatch("gm", "gpt5mini");
		expect(separatorStart).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(separatorStart as number).toBeLessThan(midWord as number);
	});

	test("equal scores preserve original input order", () => {
		const items = ["ax-by", "ax.cy", "ax_dy"];
		expect(commandParser.fuzzyFilterAndSort(items, "ay", (item) => item)).toEqual(items);
	});
});

describe("parseSlashInput", () => {
	const skills = [
		{ name: "bash", description: "Bash scripting" },
		{ name: "brainstorming", description: "Creative thinking" },
		{ name: "test-driven-development", description: "TDD workflow" },
	];

	test("non-slash input returns null", () => {
		expect(parseSlashInput("hello", skills, false)).toBeNull();
	});

	test("read-only mode returns null", () => {
		expect(parseSlashInput("/bash", skills, true)).toBeNull();
	});

	test("null skill list returns null", () => {
		expect(parseSlashInput("/bash", null, false)).toBeNull();
	});

	test("empty skill list returns null", () => {
		expect(parseSlashInput("/bash", [], false)).toBeNull();
	});

	test("exact match returns single result", () => {
		const singleSkill = [{ name: "bash", description: "d" }];
		const result = parseSlashInput("/bash", singleSkill, false);
		expect(result).not.toBeNull();
		expect(result?.prefix).toBe("bash");
		expect(result?.matches).toEqual([{ name: "bash", description: "d" }]);
	});

	test("multiple matches sorted by score", () => {
		const result = parseSlashInput("/b", skills, false);
		expect(result).not.toBeNull();
		expect(result?.matches.length).toBeGreaterThanOrEqual(2);
		// "bash" should come before "brainstorming" (both start with b, but bash is shorter prefix match)
		const names = result?.matches.map((m) => m.name);
		expect(names).toContain("bash");
		expect(names).toContain("brainstorming");
	});

	test("slash only returns all skills", () => {
		const result = parseSlashInput("/", skills, false);
		expect(result).not.toBeNull();
		expect(result?.prefix).toBe("");
		expect(result?.matches).toHaveLength(skills.length);
	});
});
