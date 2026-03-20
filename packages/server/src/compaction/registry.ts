/**
 * Builds a ToolRegistry suitable for the compaction engine.
 *
 * This exists so that code outside the main handler (e.g. the
 * compacted-context HTTP endpoint) can run compaction without
 * needing the full runtime dependencies that createSkillTool /
 * createTaskTool require (db, provider, skills registry, etc.).
 *
 * Every tool's compactionResistance and custom compact() method
 * are included.  The execute/formatCall methods are stubs — they
 * must never be called through this registry.
 */

import { bashTool } from "../tool/bash";
import { editFileTool } from "../tool/edit-file";
import { fileSearchTool } from "../tool/file-search";
import { grepSearchTool } from "../tool/grep-search";
import { listDirectoryTool } from "../tool/list-directory";
import { readFileTool } from "../tool/read-file";
import type { Tool, ToolRegistry } from "../tool/tool";
import { createToolRegistry } from "../tool/tool";
import { writeFileTool } from "../tool/write-file";
import { COMPACTION_MARKER } from "./default-strategy";

/** Minimal stub for the skill tool — only compaction-relevant fields. */
const skillCompactionStub: Tool = {
	definition: {
		type: "function",
		function: { name: "skill", description: "", parameters: { type: "object", properties: {} } },
	},
	mergeable: true,
	compactionResistance: 0.2,
	compact(_output: string, _strength: number, callArgs: Record<string, unknown>): string {
		const name = typeof callArgs.name === "string" ? callArgs.name : "unknown";
		return `${COMPACTION_MARKER} skill '${name}' was loaded and applied. Re-invoke with skill('${name}') if needed.`;
	},
	formatCall() {
		return "";
	},
	async execute() {
		throw new Error("compaction-only stub — do not call execute");
	},
};

/** Minimal stub for the task tool — only compaction-relevant fields. */
const taskCompactionStub: Tool = {
	definition: { type: "function", function: { name: "task", description: "", parameters: { type: "object", properties: {} } } },
	mergeable: false,
	compactionResistance: 0.7,
	// No custom compact — uses default strategy
	formatCall() {
		return "";
	},
	async execute() {
		throw new Error("compaction-only stub — do not call execute");
	},
};

/** Build a ToolRegistry with all tools' compaction metadata (resistance + compact methods). */
export function createCompactionRegistry(): ToolRegistry {
	return createToolRegistry([
		readFileTool,
		listDirectoryTool,
		fileSearchTool,
		writeFileTool,
		editFileTool,
		grepSearchTool,
		bashTool,
		skillCompactionStub,
		taskCompactionStub,
	]);
}
