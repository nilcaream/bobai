import { describe, expect, test } from "bun:test";
import { type DotTreeNode, resolveDotTree } from "../src/DotCommandTree";

function makeTree(): DotTreeNode {
	return {
		id: "config",
		label: "configuration",
		kind: "menu",
		children: () => [
			{
				id: "cfg.proj",
				label: "project",
				kind: "menu",
				children: () => [
					{
						id: "cfg.proj.debug",
						label: "debug",
						kind: "menu",
						children: () => [
							{ id: "cfg.proj.debug.t", label: "true", kind: "action" },
							{ id: "cfg.proj.debug.f", label: "false", kind: "action" },
						],
					},
					{
						id: "cfg.proj.provider",
						label: "provider",
						kind: "text",
					},
					{
						id: "cfg.proj.port",
						label: "port",
						kind: "text",
					},
				],
			},
			{
				id: "cfg.glob",
				label: "global",
				kind: "menu",
				children: () => [
					{
						id: "cfg.glob.debug",
						label: "debug",
						kind: "menu",
						children: () => [
							{ id: "cfg.glob.debug.t", label: "true", kind: "action" },
							{ id: "cfg.glob.debug.f", label: "false", kind: "action" },
						],
					},
				],
			},
		],
	};
}

describe("resolveDotTree", () => {
	// Empty args
	test("empty args shows root children (scopes)", () => {
		const state = resolveDotTree(makeTree(), "");
		expect(state.visible.map((n) => n.label)).toEqual(["project", "global"]);
		expect(state.filter).toBe("");
		expect(state.path).toEqual([]);
		expect(state.value).toBe("");
	});

	// Scope filtering (no trailing space = still narrowing)
	test("scope filter 'p' shows only project", () => {
		const state = resolveDotTree(makeTree(), "p");
		expect(state.visible.map((n) => n.label)).toEqual(["project"]);
		expect(state.filter).toBe("p");
		expect(state.path).toEqual([]);
	});

	test("scope filter 'g' shows only global", () => {
		const state = resolveDotTree(makeTree(), "g");
		expect(state.visible.map((n) => n.label)).toEqual(["global"]);
		expect(state.filter).toBe("g");
	});

	test("non-matching scope filter 'x' shows no options", () => {
		const state = resolveDotTree(makeTree(), "x");
		expect(state.visible).toEqual([]);
		expect(state.filter).toBe("x");
	});

	// Scope committed (trailing space = advance to fields)
	test("scope 'project' with trailing space advances to fields", () => {
		const state = resolveDotTree(makeTree(), "project ");
		expect(state.visible.map((n) => n.label)).toEqual(["debug", "provider", "port"]);
		expect(state.path).toEqual(["project"]);
		expect(state.filter).toBe("");
	});

	test("scope 'g' with trailing space advances to fields", () => {
		const state = resolveDotTree(makeTree(), "g ");
		expect(state.visible.map((n) => n.label)).toEqual(["debug"]);
		expect(state.path).toEqual(["global"]);
	});

	// Multiple tokens (auto-advance for non-last tokens)
	test("two tokens 'project debug' filters fields by 'debug'", () => {
		const state = resolveDotTree(makeTree(), "project debug");
		expect(state.visible.map((n) => n.label)).toEqual(["debug"]);
		expect(state.path).toEqual(["project"]);
		expect(state.filter).toBe("debug");
	});

	test("two tokens 'project de' filters fields by 'de'", () => {
		const state = resolveDotTree(makeTree(), "project de");
		expect(state.visible.map((n) => n.label)).toEqual(["debug"]);
		expect(state.filter).toBe("de");
		expect(state.path).toEqual(["project"]);
	});

	// Field committed → value options
	test("three tokens 'project debug true' shows value being filtered", () => {
		const state = resolveDotTree(makeTree(), "project debug true");
		// "true" is the 3rd token, no trailing space → not committed yet, filtering at debug level
		expect(state.visible.map((n) => n.label)).toEqual(["true"]);
		expect(state.path).toEqual(["project", "debug"]);
		expect(state.filter).toBe("true");
	});

	test("three tokens with trailing space commits value", () => {
		const state = resolveDotTree(makeTree(), "project debug true ");
		expect(state.visible).toEqual([]);
		expect(state.path).toEqual(["project", "debug", "true"]);
		expect(state.currentNode.kind).toBe("action");
		expect(state.filter).toBe("");
	});

	test("three tokens 'project debug t' filters value options by 't'", () => {
		const state = resolveDotTree(makeTree(), "project debug t");
		expect(state.visible.map((n) => n.label)).toEqual(["true"]);
		expect(state.path).toEqual(["project", "debug"]);
		expect(state.filter).toBe("t");
	});

	test("three tokens 'project debug z' shows no matching values", () => {
		const state = resolveDotTree(makeTree(), "project debug z");
		expect(state.visible).toEqual([]);
		expect(state.filter).toBe("z");
	});

	// Ambiguous prefixes
	test("ambiguous field prefix shows multiple matches", () => {
		const state = resolveDotTree(makeTree(), "project p");
		// "p" matches "provider" and "port" — not committed, so both show
		expect(state.visible.map((n) => n.label)).toEqual(["provider", "port"]);
		expect(state.path).toEqual(["project"]);
		expect(state.filter).toBe("p");
	});

	test("ambiguous field prefix with trailing space stays at field level", () => {
		const state = resolveDotTree(makeTree(), "project p ");
		// "p" + space — still ambiguous, shows both matches
		expect(state.visible.map((n) => n.label)).toEqual(["provider", "port"]);
		expect(state.path).toEqual(["project"]);
		expect(state.filter).toBe("p");
	});

	// Text kind nodes
	test("text kind node 'provider' not yet committed shows in visible list", () => {
		const state = resolveDotTree(makeTree(), "project provider");
		// "provider" is the last token, no trailing space → still filtering at field level
		expect(state.visible.map((n) => n.label)).toEqual(["provider"]);
		expect(state.value).toBe("");
		expect(state.path).toEqual(["project"]);
	});

	test("text kind node 'provider' with value advances to text node", () => {
		const state = resolveDotTree(makeTree(), "project provider github-copilot");
		// "provider" is not the last token → committed → advances into text node
		expect(state.value).toBe("github-copilot");
		expect(state.path).toEqual(["project", "provider"]);
		expect(state.currentNode.kind).toBe("text");
	});

	test("text kind node committed with trailing space shows text input ready", () => {
		const state = resolveDotTree(makeTree(), "project port ");
		// "port" + trailing space → committed → at text node, no value yet
		expect(state.value).toBe("");
		expect(state.path).toEqual(["project", "port"]);
		expect(state.currentNode.kind).toBe("text");
		expect(state.visible).toEqual([]);
	});

	// Deep traversal
	test("full path with trailing space reaches action node", () => {
		const state = resolveDotTree(makeTree(), "project debug true ");
		expect(state.path).toEqual(["project", "debug", "true"]);
		expect(state.currentNode.kind).toBe("action");
		expect(state.currentNode.label).toBe("true");
	});
});
