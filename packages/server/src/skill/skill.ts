import fs from "node:fs";
import matter from "gray-matter";
import type { BuiltinSkillSource } from "./builtin";

/** Recognized skill modes. Only skills matching the active runtime context are loaded. */
type SkillMode = "debug";

const VALID_MODES = new Set<string>(["debug"]);

export interface Skill {
	name: string;
	description: string;
	content: string;
	filePath: string;
	mode?: SkillMode;
}

export interface SkillRegistry {
	get(name: string): Skill | undefined;
	list(): Skill[];
}

export function parseSkillFile(raw: string, filePath: string): Skill | null {
	let parsed: matter.GrayMatterFile<string>;
	try {
		parsed = matter(raw);
	} catch {
		return null;
	}

	const { data, content } = parsed;
	const name = typeof data.name === "string" ? data.name.trim() : "";
	const description = typeof data.description === "string" ? data.description.trim() : "";

	if (!name || !description) return null;

	const mode = typeof data.mode === "string" && VALID_MODES.has(data.mode.trim()) ? (data.mode.trim() as SkillMode) : undefined;

	return { name, description, content: content.trim(), filePath, mode };
}

export interface DiscoverSkillsOptions {
	debug?: boolean;
	builtinSkills?: BuiltinSkillSource[];
}

/** Returns true when a skill is allowed under the current runtime context. */
function isAllowed(skill: Skill, debug: boolean): boolean {
	return skill.mode !== "debug" || debug;
}

export function discoverSkills(directories: string[], options: DiscoverSkillsOptions = {}): SkillRegistry {
	const skills = new Map<string, Skill>();
	const debug = options.debug ?? false;

	// Built-in skills are loaded first (lowest precedence).
	// Directory-scanned skills override them by name.
	if (options.builtinSkills) {
		for (const entry of options.builtinSkills) {
			const skill = parseSkillFile(entry.raw, `<builtin>/${entry.relativePath}`);
			if (skill && isAllowed(skill, debug)) {
				skills.set(skill.name, skill);
			}
		}
	}

	for (const dir of directories) {
		if (!fs.existsSync(dir)) continue;

		const files = Array.from(new Bun.Glob("**/SKILL.md").scanSync({ cwd: dir, absolute: true, followSymlinks: true })).sort();

		for (const filePath of files) {
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const skill = parseSkillFile(raw, filePath);
				if (skill && isAllowed(skill, debug)) {
					skills.set(skill.name, skill);
				}
			} catch {
				// Skip unreadable files
			}
		}
	}

	const registry: SkillRegistry = {
		get(name: string) {
			return skills.get(name);
		},
		list() {
			return Array.from(skills.values());
		},
	};

	return registry;
}
