/**
 * Builds a ToolRegistry suitable for the compaction engine.
 *
 * This exists so that code outside the main handler (e.g. the
 * compacted-context HTTP endpoint) can run compaction without
 * needing the full runtime dependencies that createSkillTool /
 * createTaskTool require (db, provider, skills registry, etc.).
 *
 * Every tool's outputThreshold/argsThreshold and custom compact()
 * method are included. The execute/formatCall methods are stubs —
 * they must never be called through this registry.
 */

import fs from "node:fs";
import path from "node:path";
import { bashTool } from "../tool/bash";
import { editFileTool } from "../tool/edit-file";
import { fileSearchTool } from "../tool/file-search";
import { grepSearchTool } from "../tool/grep-search";
import { listDirectoryTool } from "../tool/list-directory";
import { readFileTool } from "../tool/read-file";
import { SKILL_OUTPUT_THRESHOLD } from "../tool/skill";
import { sqlite3Tool } from "../tool/sqlite3";
import { TASK_ARGS_THRESHOLD, TASK_OUTPUT_THRESHOLD } from "../tool/task";
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
	outputThreshold: SKILL_OUTPUT_THRESHOLD,
	compact(_output: string, callArgs: Record<string, unknown>): string {
		const name = typeof callArgs.name === "string" ? callArgs.name : "unknown";
		return `${COMPACTION_MARKER} skill(${JSON.stringify({ name })}) was loaded and applied. Re-invoke if needed.`;
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
	outputThreshold: TASK_OUTPUT_THRESHOLD,
	argsThreshold: TASK_ARGS_THRESHOLD,
	compact(output: string, callArgs: Record<string, unknown>, context?: { sessionId: string; toolCallId: string }): string {
		if (context) {
			const dir = path.join(".bobai", "compaction", context.sessionId);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${context.toolCallId}.md`), output);
		}
		const description = typeof callArgs.description === "string" ? callArgs.description : "?";
		const filePath = context
			? `.bobai/compaction/${context.sessionId}/${context.toolCallId}.md`
			: ".bobai/compaction/<unknown>.md";
		return `${COMPACTION_MARKER} task(${JSON.stringify({ description })}) output saved to ${filePath} — use read_file to see full result.`;
	},
	compactArgs(args: Record<string, unknown>): Record<string, unknown> {
		const result = { ...args };
		if (typeof result.prompt === "string") result.prompt = COMPACTION_MARKER;
		return result;
	},
	formatCall() {
		return "";
	},
	async execute() {
		throw new Error("compaction-only stub — do not call execute");
	},
};

/** Build a ToolRegistry with all tools' compaction metadata (thresholds + compact methods). */
export function createCompactionRegistry(): ToolRegistry {
	return createToolRegistry([
		readFileTool,
		listDirectoryTool,
		fileSearchTool,
		writeFileTool,
		editFileTool,
		grepSearchTool,
		bashTool,
		sqlite3Tool,
		skillCompactionStub,
		taskCompactionStub,
	]);
}
