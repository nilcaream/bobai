import type { ParsedSlashInput } from "./commandParser";

export function SlashCommandPanel({ parsed }: { parsed: ParsedSlashInput | null }) {
	if (!parsed) return null;

	const content =
		parsed.matches.length > 0 ? (
			parsed.matches.map((s) => (
				<div key={s.name} className="slash-skill-row">
					{s.name} <span className="slash-skill-desc">— {s.description}</span>
				</div>
			))
		) : (
			<div>No matching skills</div>
		);

	return <div className="panel panel--dot">{content}</div>;
}
