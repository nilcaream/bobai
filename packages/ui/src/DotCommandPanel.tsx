import type { DotCommand, ParsedDotInput } from "./commandParser";

export function DotCommandPanel({
	parsed,
	modelList,
	sessionList,
	subagentList,
	getSessionId,
	sessionLocked,
}: {
	parsed: ParsedDotInput | null;
	modelList: { index: number; id: string; cost: string }[] | null;
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null;
	subagentList: { index: number; title: string; sessionId: string }[] | null;
	getSessionId: () => string | null;
	sessionLocked: boolean;
}) {
	if (!parsed) return null;

	let content: React.ReactNode;

	if (parsed.mode === "select") {
		content = renderSelectMode(parsed.matches);
	} else if (parsed.command === "model") {
		content = renderModelPanel(parsed.args, modelList);
	} else if (parsed.command === "new") {
		const newTitle = parsed.args.trim();
		content = newTitle ? `Start a new chat session: ${newTitle}` : "Start a new chat session (optional title)";
	} else if (parsed.command === "title") {
		const titleText = parsed.args.trim();
		content = titleText ? `Set session title: ${titleText}` : "Enter session title";
	} else if (parsed.command === "session") {
		content = renderSessionPanel(parsed.args, sessionList, getSessionId, sessionLocked);
	} else if (parsed.command === "subagent") {
		content = renderSubagentPanel(parsed.args, subagentList);
	} else if (parsed.command === "view") {
		const views = [
			{ index: 1, name: "Chat", desc: "Grouped panels, markdown" },
			{ index: 2, name: "Context", desc: "Raw DB messages, plain text" },
			{ index: 3, name: "Compaction", desc: "Compacted view (what LLM sees)" },
		];
		content = views.map((v) => (
			<div key={v.index}>
				{v.index}: {v.name} — {v.desc}
			</div>
		));
	} else {
		return null;
	}

	return <div className="panel panel--dot">{content}</div>;
}

function renderSelectMode(matches: DotCommand[]) {
	return matches.length > 0 ? (
		matches.map((cmd) => (
			<div key={cmd.name} className="slash-skill-row">
				{cmd.name} <span className="slash-skill-desc">— {cmd.description}</span>
			</div>
		))
	) : (
		<div>No matching commands</div>
	);
}

function renderModelPanel(args: string, modelList: { index: number; id: string; cost: string }[] | null) {
	if (!modelList) return "Loading models...";
	const filtered = args ? modelList.filter((m) => String(m.index).startsWith(args.trim())) : modelList;
	return filtered.length > 0 ? (
		filtered.map((m) => (
			<div key={m.id}>
				{m.index}: {m.id} ({m.cost})
			</div>
		))
	) : (
		<div>No matching models</div>
	);
}

function renderSessionPanel(
	args: string,
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null,
	getSessionId: () => string | null,
	sessionLocked: boolean,
) {
	if (!sessionList) return "Loading sessions...";
	if (sessionList.length === 0) return "No sessions";

	const SESSION_DISPLAY_LIMIT = 32;
	const argText = (args ?? "").trim();
	const argParts = argText.split(/\s+/);
	const indexPart = argParts[0] ?? "";
	const subcommand = argParts[1];
	const filtered = indexPart ? sessionList.filter((s) => String(s.index).includes(indexPart)) : sessionList;

	// If user typed "N delete", show a delete preview instead of the session list
	if (subcommand === "delete") {
		const idx = Number.parseInt(indexPart, 10);
		const target = !Number.isNaN(idx) ? sessionList.find((s) => s.index === idx) : undefined;
		if (target) {
			const label = target.title ? `"${target.title}"` : `#${target.index}`;
			return `Delete session ${label}`;
		}
		return `Invalid session index: ${indexPart}`;
	}

	const display = filtered.slice(0, SESSION_DISPLAY_LIMIT);
	const maxIndex = Math.max(...display.map((s) => s.index));
	const padWidth = String(maxIndex).length;
	return display.length > 0 ? (
		display.map((s) => {
			const isCurrentSession = s.id === getSessionId();
			const isOwnedBySelf = isCurrentSession && !sessionLocked;
			const isOwnedByOther = s.owned && !isOwnedBySelf;
			const localTime = new Date(s.updatedAt)
				.toLocaleString("sv-SE", {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
					hour12: false,
				})
				.replace(",", "");
			const paddedIndex = String(s.index).padStart(padWidth, " ");
			return (
				<div key={s.id}>
					{paddedIndex}: {localTime} {s.title ?? ""}
					{isOwnedByOther ? " (active in another tab)" : ""}
					{isOwnedBySelf ? " (this session)" : ""}
				</div>
			);
		})
	) : (
		<div>No matching sessions</div>
	);
}

function renderSubagentPanel(args: string, subagentList: { index: number; title: string; sessionId: string }[] | null) {
	if (!subagentList) return "Loading subagents...";
	if (subagentList.length === 0) return "No subagent sessions";

	const SUBAGENT_DISPLAY_LIMIT = 32;
	const indexPart = (args ?? "").trim();
	const filtered = indexPart ? subagentList.filter((s) => String(s.index).includes(indexPart)) : subagentList;
	const display = filtered.slice(0, SUBAGENT_DISPLAY_LIMIT);
	const maxIndex = display.length > 0 ? Math.max(...display.map((s) => s.index)) : 0;
	const padWidth = String(maxIndex).length;
	return display.length > 0 ? (
		display.map((s) => {
			const paddedIndex = String(s.index).padStart(padWidth, " ");
			return (
				<div key={s.sessionId}>
					{paddedIndex}: {s.title}
				</div>
			);
		})
	) : (
		<div>No matching subagents</div>
	);
}
