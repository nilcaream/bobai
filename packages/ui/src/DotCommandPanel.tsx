import type { DotCommand, ParsedDotInput } from "./commandParser";
import { fuzzyFilterAndSort } from "./commandParser";

export type ModelListItem = { index: number; id: string; cost: string; contextWindow: number };

export function DotCommandPanel({
	parsed,
	modelList,
	sessionList,
	subagentList,
	getSessionId,
	sessionLocked,
}: {
	parsed: ParsedDotInput | null;
	modelList: ModelListItem[] | null;
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

function renderModelPanel(args: string, modelList: ModelListItem[] | null) {
	if (!modelList) return "Loading models...";
	const argText = (args ?? "").trim();
	const firstToken = argText.split(/\s+/)[0] ?? "";
	const isNumeric = !argText || /^\d+$/.test(firstToken);
	const filtered = isNumeric
		? firstToken
			? modelList.filter((m) => String(m.index).includes(firstToken))
			: modelList
		: fuzzyFilterAndSort(modelList, argText, (m) => m.id).slice(0, 20);
	if (filtered.length === 0) return <div>No matching models</div>;
	const maxIndex = Math.max(...filtered.map((m) => m.index));
	const padWidth = String(maxIndex).length;
	return filtered.map((m) => {
		const paddedIndex = String(m.index).padStart(padWidth, " ");
		const suffix = m.contextWindow > 0 ? `(${m.cost}, ${formatContextWindow(m.contextWindow)})` : `(${m.cost})`;
		return (
			<div key={m.id}>
				{paddedIndex}: {m.id} {suffix}
			</div>
		);
	});
}

function formatContextWindow(contextWindow: number): string {
	return `${Math.round(contextWindow / 1000)}k`;
}

function renderSessionPanel(
	args: string,
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null,
	getSessionId: () => string | null,
	sessionLocked: boolean,
) {
	if (!sessionList) return "Loading sessions...";
	if (sessionList.length === 0) return "No sessions";

	const SESSION_DISPLAY_LIMIT = 20;
	const argText = (args ?? "").trim();
	const isNumeric = !argText || /^\d+$/.test(argText.split(/\s+/)[0] ?? "");

	// Numeric mode: filter by index, support "N delete" subcommand
	if (isNumeric) {
		const argParts = argText.split(/\s+/);
		const indexPart = argParts[0] ?? "";
		const subcommand = argParts[1];

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

		const filtered = indexPart ? sessionList.filter((s) => String(s.index).includes(indexPart)) : sessionList;
		return renderSessionList(filtered, SESSION_DISPLAY_LIMIT, getSessionId, sessionLocked);
	}

	// Text mode: fuzzy rank by title
	const filtered = fuzzyFilterAndSort(
		sessionList.filter((s) => s.title),
		argText,
		(s) => s.title ?? "",
	).slice(0, SESSION_DISPLAY_LIMIT);
	return renderSessionList(filtered, SESSION_DISPLAY_LIMIT, getSessionId, sessionLocked);
}

function renderSessionList(
	filtered: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[],
	limit: number,
	getSessionId: () => string | null,
	sessionLocked: boolean,
) {
	const display = filtered.slice(0, limit);
	if (display.length === 0) return <div>No matching sessions</div>;
	const maxIndex = Math.max(...display.map((s) => s.index));
	const padWidth = String(maxIndex).length;
	return display.map((s) => {
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
	});
}

function renderSubagentPanel(args: string, subagentList: { index: number; title: string; sessionId: string }[] | null) {
	if (!subagentList) return "Loading subagents...";
	if (subagentList.length === 0) return "No subagent sessions";

	const SUBAGENT_DISPLAY_LIMIT = 20;
	const argText = (args ?? "").trim();
	const firstToken = argText.split(/\s+/)[0] ?? "";
	const isNumeric = !argText || /^\d+$/.test(firstToken);
	const filtered = isNumeric
		? firstToken
			? subagentList.filter((s) => String(s.index).includes(firstToken))
			: subagentList
		: fuzzyFilterAndSort(subagentList, argText, (s) => s.title).slice(0, SUBAGENT_DISPLAY_LIMIT);
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
