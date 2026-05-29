import { describe, expect, test } from "bun:test";
import { type DotTreeNode, resolveDotTree } from "../src/DotCommandTree";

/** Utility: prefix-matching filter helper. */
function pf(items: DotTreeNode[], filter: string): DotTreeNode[] {
	if (!filter) return items;
	return items.filter((n) => n.label.toLowerCase().startsWith(filter.toLowerCase()));
}

function makeTree(): DotTreeNode {
	return {
		id: "config",
		label: "configuration",
		kind: "menu",
		children: (f: string) =>
			pf(
				[
					{
						id: "cfg.proj",
						label: "project",
						kind: "menu" as const,
						children: (f2: string) =>
							pf(
								[
									{
										id: "cfg.proj.debug",
										label: "debug",
										kind: "menu" as const,
										children: (f3: string) =>
											pf(
												[
													{ id: "cfg.proj.debug.t", label: "true", kind: "action" as const },
													{ id: "cfg.proj.debug.f", label: "false", kind: "action" as const },
												],
												f3,
											),
									},
									{ id: "cfg.proj.provider", label: "provider", kind: "text" as const },
									{ id: "cfg.proj.port", label: "port", kind: "text" as const },
								],
								f2,
							),
					},
					{
						id: "cfg.glob",
						label: "global",
						kind: "menu" as const,
						children: (f2: string) =>
							pf(
								[
									{
										id: "cfg.glob.debug",
										label: "debug",
										kind: "menu" as const,
										children: (f3: string) =>
											pf(
												[
													{ id: "cfg.glob.debug.t", label: "true", kind: "action" as const },
													{ id: "cfg.glob.debug.f", label: "false", kind: "action" as const },
												],
												f3,
											),
									},
								],
								f2,
							),
					},
				],
				f,
			),
	};
}

describe("resolveDotTree — children(filter) API", () => {
	test("empty args shows root children", () => {
		const state = resolveDotTree(makeTree(), "");
		expect(state.visible.map((n) => n.label)).toEqual(["project", "global"]);
		expect(state.filter).toBe("");
		expect(state.path).toEqual([]);
	});

	test("filter 'p' shows only project", () => {
		const state = resolveDotTree(makeTree(), "p");
		expect(state.visible.map((n) => n.label)).toEqual(["project"]);
		expect(state.filter).toBe("p");
	});

	test("'p ' (trailing space) commits to project and shows fields", () => {
		const state = resolveDotTree(makeTree(), "p ");
		expect(state.visible.map((n) => n.label)).toEqual(["debug", "provider", "port"]);
		expect(state.path).toEqual(["project"]);
	});

	test("'project debug' shows field hint, not values", () => {
		const state = resolveDotTree(makeTree(), "project debug");
		expect(state.visible.map((n) => n.label)).toEqual(["debug"]);
		expect(state.path).toEqual(["project"]);
	});

	test("'project debug ' (trailing space) commits field and shows values", () => {
		const state = resolveDotTree(makeTree(), "project debug ");
		expect(state.visible.map((n) => n.label)).toEqual(["true", "false"]);
		expect(state.path).toEqual(["project", "debug"]);
	});

	test("value filter 't' shows only true", () => {
		const state = resolveDotTree(makeTree(), "project debug t");
		expect(state.visible.map((n) => n.label)).toEqual(["true"]);
		expect(state.filter).toBe("t");
	});

	test("non-matching value filter returns empty visible", () => {
		const state = resolveDotTree(makeTree(), "project debug z");
		expect(state.visible).toEqual([]);
		expect(state.filter).toBe("z");
	});

	test("ambiguous field prefix shows matching fields only", () => {
		const state = resolveDotTree(makeTree(), "project p");
		expect(state.visible.map((n) => n.label)).toEqual(["provider", "port"]);
	});

	test("text node 'provider' captures value from remaining tokens", () => {
		const state = resolveDotTree(makeTree(), "project provider github-copilot");
		expect(state.currentNode.kind).toBe("text");
		expect(state.currentNode.label).toBe("provider");
		expect(state.value).toBe("github-copilot");
		expect(state.path).toEqual(["project", "provider"]);
	});

	test("text node with space shows hint (empty value)", () => {
		const state = resolveDotTree(makeTree(), "project port ");
		expect(state.currentNode.kind).toBe("text");
		expect(state.currentNode.label).toBe("port");
		expect(state.value).toBe("");
		expect(state.path).toEqual(["project", "port"]);
	});

	test("no-match scope returns empty visible", () => {
		const state = resolveDotTree(makeTree(), "zzz");
		expect(state.visible).toEqual([]);
		expect(state.filter).toBe("zzz");
	});

	test("three tokens 'project debug true' — true not committed yet", () => {
		const state = resolveDotTree(makeTree(), "project debug true");
		expect(state.visible.map((n) => n.label)).toEqual(["true"]);
		expect(state.path).toEqual(["project", "debug"]);
	});

	test("full path with trailing space reaches action node", () => {
		const state = resolveDotTree(makeTree(), "project debug true ");
		expect(state.path).toEqual(["project", "debug", "true"]);
		expect(state.currentNode.kind).toBe("action");
		expect(state.currentNode.label).toBe("true");
	});
});
