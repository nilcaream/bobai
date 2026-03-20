import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext, ToolResult } from "../src/tool/tool";
import { createToolRegistry, isPathAccessible } from "../src/tool/tool";

function fakeTool(name: string): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name,
				description: `Fake ${name}`,
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
		execute: async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
			return { output: `executed ${name}` };
		},
	};
}

describe("createToolRegistry", () => {
	test("returns definitions for all registered tools", () => {
		const registry = createToolRegistry([fakeTool("alpha"), fakeTool("beta")]);
		expect(registry.definitions).toHaveLength(2);
		expect(registry.definitions[0].function.name).toBe("alpha");
		expect(registry.definitions[1].function.name).toBe("beta");
	});

	test("get returns tool by name", () => {
		const tool = fakeTool("alpha");
		const registry = createToolRegistry([tool]);
		expect(registry.get("alpha")).toBe(tool);
	});

	test("get returns undefined for unknown tool", () => {
		const registry = createToolRegistry([fakeTool("alpha")]);
		expect(registry.get("unknown")).toBeUndefined();
	});
});

describe("isPathAccessible", () => {
	test("allows paths within projectRoot", () => {
		const ctx: ToolContext = { projectRoot: "/home/user/project" };
		expect(isPathAccessible("/home/user/project/src/file.ts", ctx)).toBe(true);
	});

	test("allows projectRoot itself", () => {
		const ctx: ToolContext = { projectRoot: "/home/user/project" };
		expect(isPathAccessible("/home/user/project", ctx)).toBe(true);
	});

	test("rejects paths outside projectRoot when no accessibleDirectories", () => {
		const ctx: ToolContext = { projectRoot: "/home/user/project" };
		expect(isPathAccessible("/home/user/other/file.ts", ctx)).toBe(false);
	});

	test("allows paths within accessibleDirectories", () => {
		const ctx: ToolContext = {
			projectRoot: "/home/user/project",
			accessibleDirectories: ["/home/user/.config/bobai/skills"],
		};
		expect(isPathAccessible("/home/user/.config/bobai/skills/tdd/SKILL.md", ctx)).toBe(true);
	});

	test("allows accessible directory itself", () => {
		const ctx: ToolContext = {
			projectRoot: "/home/user/project",
			accessibleDirectories: ["/home/user/.config/bobai/skills"],
		};
		expect(isPathAccessible("/home/user/.config/bobai/skills", ctx)).toBe(true);
	});

	test("rejects paths outside both projectRoot and accessibleDirectories", () => {
		const ctx: ToolContext = {
			projectRoot: "/home/user/project",
			accessibleDirectories: ["/home/user/.config/bobai/skills"],
		};
		expect(isPathAccessible("/etc/passwd", ctx)).toBe(false);
	});

	test("prevents prefix confusion (projectRoot=/foo should not allow /foobar)", () => {
		const ctx: ToolContext = { projectRoot: "/foo" };
		expect(isPathAccessible("/foobar/file.ts", ctx)).toBe(false);
	});

	test("prevents prefix confusion with accessibleDirectories", () => {
		const ctx: ToolContext = {
			projectRoot: "/project",
			accessibleDirectories: ["/home/skills"],
		};
		expect(isPathAccessible("/home/skillsxyz/file.ts", ctx)).toBe(false);
	});

	test("handles empty accessibleDirectories", () => {
		const ctx: ToolContext = { projectRoot: "/project", accessibleDirectories: [] };
		expect(isPathAccessible("/outside/file.ts", ctx)).toBe(false);
		expect(isPathAccessible("/project/file.ts", ctx)).toBe(true);
	});
});
