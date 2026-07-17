import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext, ToolResult } from "../src/tool/tool";
import { createToolRegistry } from "../src/tool/tool";

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
