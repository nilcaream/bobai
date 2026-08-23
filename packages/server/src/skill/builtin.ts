import debuggingBobaiSessions from "../../skills/debugging-bobai-sessions/SKILL.md" with { type: "text" };
import openrouterCodingModel from "../../skills/openrouter-coding-model/SKILL.md" with { type: "text" };

export interface BuiltinSkillSource {
	raw: string;
	relativePath: string;
}

export const builtinSkills: BuiltinSkillSource[] = [
	{
		raw: debuggingBobaiSessions,
		relativePath: "skills/debugging-bobai-sessions/SKILL.md",
	},
	{
		raw: openrouterCodingModel,
		relativePath: "skills/openrouter-coding-model/SKILL.md",
	},
];
