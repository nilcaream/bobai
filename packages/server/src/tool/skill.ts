import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { SkillRegistry } from "../skill/skill";
import type { Tool, ToolContext, ToolResult } from "./tool";

export function createSkillTool(skills: SkillRegistry): Tool {
	const skillList = skills.list();
	const namesList = skillList.map((s) => s.name).join(", ");

	const description =
		skillList.length > 0
			? `Load a skill by name to get specialized instructions and workflows. Available skills: ${namesList}`
			: "Load a skill by name to get specialized instructions and workflows. No skills are currently available.";

	return {
		definition: {
			type: "function",
			function: {
				name: "skill",
				description,
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "The name of the skill to load",
						},
					},
					required: ["name"],
				},
			},
		},
		mergeable: true,
		outputThreshold: 0.46,

		compact(_output: string, callArgs: Record<string, unknown>): string {
			const name = typeof callArgs.name === "string" ? callArgs.name : "unknown";
			return `${COMPACTION_MARKER} skill(${JSON.stringify({ name })}) was loaded and applied. Re-invoke if needed.`;
		},

		formatCall(args: Record<string, unknown>): string {
			return `▸ Loading ${args.name ?? "unknown"} skill`;
		},
		async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
			const name = args.name;
			if (typeof name !== "string" || name.trim().length === 0) {
				const msg = "Error: 'name' parameter is required and must be a non-empty string.";
				return { llmOutput: msg, uiOutput: msg, mergeable: true };
			}

			const skill = skills.get(name);

			if (!skill) {
				const msg = namesList
					? `Skill "${name}" not found. Available skills: ${namesList}`
					: `Skill "${name}" not found. No skills are available.`;
				return { llmOutput: msg, uiOutput: `▸ Loading ${name} skill — not found`, mergeable: true };
			}

			const baseDir = path.dirname(skill.filePath);
			const llmOutput = `# Skill: ${skill.name}\n\n${skill.content}\n\n---\nSource: ${skill.filePath}\nBase directory: ${baseDir} (use to construct absolute paths when reading files referenced by this skill)`;
			const uiOutput = `▸ Loaded ${skill.name} skill`;

			return { llmOutput, uiOutput, mergeable: true };
		},
	};
}
