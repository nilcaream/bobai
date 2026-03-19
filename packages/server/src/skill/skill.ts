import fs from "node:fs";
import matter from "gray-matter";

export interface Skill {
	name: string;
	description: string;
	content: string;
	filePath: string;
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

	return { name, description, content: content.trim(), filePath };
}

export function discoverSkills(directories: string[]): SkillRegistry {
	const skills = new Map<string, Skill>();

	for (const dir of directories) {
		if (!fs.existsSync(dir)) continue;

		const files = Array.from(new Bun.Glob("**/SKILL.md").scanSync({ cwd: dir, absolute: true })).sort();

		for (const filePath of files) {
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const skill = parseSkillFile(raw, filePath);
				if (skill) {
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
