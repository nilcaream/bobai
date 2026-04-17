import { fuzzyMatch, SLASH_FUZZY_OPTIONS } from "./fuzzySearch";

export { fuzzyFilterAndSort, fuzzyMatch } from "./fuzzySearch";

export type DotCommand = { name: string; description: string };

export type SkillInfo = { name: string; description: string };

export type ParsedDotInput = {
	mode: "select" | "args";
	prefix: string;
	matches: DotCommand[];
	args: string;
	command: string | undefined;
};

export type ParsedSlashInput = {
	prefix: string;
	matches: SkillInfo[];
};

export const VIEW_MODES = ["chat", "context", "compaction"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const ALL_DOT_COMMANDS: Record<string, DotCommand> = {
	model: { name: "model", description: "Switch the AI model" },
	new: { name: "new", description: "Start a new chat session" },
	session: { name: "session", description: "Switch to another session" },
	stop: { name: "stop", description: "Stop the current response" },
	subagent: { name: "subagent", description: "View subagent sessions" },
	title: { name: "title", description: "Rename the current session" },
	view: { name: "view", description: "Switch view mode" },
};

export const pick = (...keys: string[]): DotCommand[] =>
	keys.flatMap((k) => {
		const cmd = ALL_DOT_COMMANDS[k];
		return cmd ? [cmd] : [];
	});

export const FULL_DOT_COMMANDS = pick("model", "new", "session", "subagent", "title", "view");
export const READ_ONLY_DOT_COMMANDS = pick("new", "session", "subagent", "title", "view");
export const LOCKED_DOT_COMMANDS = pick("new", "session");
export const STREAMING_DOT_COMMANDS = pick("stop", "subagent");

export function parseDotInput(text: string, activeDotCommands: DotCommand[]): ParsedDotInput | null {
	if (!text.startsWith(".")) return null;
	const withoutDot = text.slice(1);
	const spaceIndex = withoutDot.indexOf(" ");
	if (spaceIndex === -1) {
		const prefix = withoutDot.toLowerCase();
		const matches = activeDotCommands.filter((c) => c.name.startsWith(prefix));
		// Number shorthand: .model1 → command="model", args="1"
		// No dot command name contains a digit, so trailing digits are always an arg.
		if (matches.length === 0) {
			const m = prefix.match(/^([a-z]+)(\d+)$/);
			const cmdPart = m?.[1];
			const numPart = m?.[2];
			if (cmdPart && numPart) {
				const cmdMatches = activeDotCommands.filter((c) => c.name.startsWith(cmdPart));
				if (cmdMatches.length === 1) {
					return { mode: "args" as const, prefix: cmdPart, matches: cmdMatches, args: numPart, command: cmdMatches[0]?.name };
				}
			}
		}
		return { mode: "select" as const, prefix, matches, args: "", command: undefined };
	}
	const cmdPart = withoutDot.slice(0, spaceIndex).toLowerCase();
	const matches = activeDotCommands.filter((c) => c.name.startsWith(cmdPart));
	if (matches.length === 1) {
		return {
			mode: "args" as const,
			prefix: cmdPart,
			matches,
			args: withoutDot.slice(spaceIndex + 1),
			command: matches[0]?.name,
		};
	}
	return { mode: "select" as const, prefix: cmdPart, matches, args: "", command: undefined };
}

export function fuzzyMatchSkill(query: string, name: string): number | null {
	return fuzzyMatch(query, name, SLASH_FUZZY_OPTIONS);
}

export function parseSlashInput(text: string, skillList: SkillInfo[] | null, isReadOnly: boolean): ParsedSlashInput | null {
	if (!text.startsWith("/") || isReadOnly) return null;
	if (!skillList || skillList.length === 0) return null;
	const withoutSlash = text.slice(1);
	const query = withoutSlash.toLowerCase();
	const scored: { skill: SkillInfo; score: number }[] = [];
	for (const s of skillList) {
		const score = fuzzyMatchSkill(query, s.name);
		if (score !== null) scored.push({ skill: s, score });
	}
	scored.sort((a, b) => a.score - b.score);
	const matches = scored.map((s) => s.skill);
	return { prefix: query, matches };
}
