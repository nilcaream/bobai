import { describe, expect, test } from "bun:test";
import type { Tool, ToolResult } from "../src/tool/tool";

describe("Tool interface", () => {
	test("ToolResult has llmOutput, uiOutput, isError, mergeable", () => {
		const result: ToolResult = {
			llmOutput: "file contents here",
			uiOutput: "▸ Reading src/app.ts (150 lines)",
			isError: false,
			mergeable: true,
		};
		expect(result.llmOutput).toBe("file contents here");
		expect(result.uiOutput).toBe("▸ Reading src/app.ts (150 lines)");
		expect(result.isError).toBe(false);
		expect(result.mergeable).toBe(true);
	});

	test("ToolResult uiOutput can be null", () => {
		const result: ToolResult = {
			llmOutput: "Edited file",
			uiOutput: null,
			isError: false,
			mergeable: false,
		};
		expect(result.uiOutput).toBeNull();
	});

	test("Tool interface requires formatCall and mergeable", () => {
		const tool: Tool = {
			definition: {
				type: "function",
				function: {
					name: "test_tool",
					description: "test",
					parameters: { type: "object", properties: {}, required: [] },
				},
			},
			mergeable: true,
			formatCall(args: Record<string, unknown>): string {
				return `▸ Testing ${args.name}`;
			},
			async execute(): Promise<ToolResult> {
				return { llmOutput: "ok", uiOutput: "ok", isError: false, mergeable: true };
			},
		};
		expect(tool.mergeable).toBe(true);
		expect(tool.formatCall({ name: "foo" })).toBe("▸ Testing foo");
	});
});
