import type { DotTreeNode } from "../DotCommandTree";
import { fuzzyFilterAndSort } from "../fuzzySearch";

type ModelListItem = { index: number; id: string; cost: string; contextWindow: number };
type ProviderListItem = { index: number; id: string; runtimeSupported: boolean };

function formatContextWindow(cw: number): string {
	return `${Math.round(cw / 1000)}k`;
}

// ── view ────────────────────────────────────────────────────────────────────

export const viewTree: DotTreeNode = {
	id: "view",
	label: "view",
	description: "Change the view",
	kind: "menu",
	children: (f: string) =>
		pf(
			[
				{ id: "view.1", label: "1: Chat", description: "Grouped panels, markdown", commitValue: "1", kind: "action" as const },
				{
					id: "view.2",
					label: "2: Context",
					description: "Raw DB messages, plain text",
					commitValue: "2",
					kind: "action" as const,
				},
				{
					id: "view.3",
					label: "3: Compaction",
					description: "Compacted view (what LLM sees)",
					commitValue: "3",
					kind: "action" as const,
				},
			],
			f,
		),
};

// ── new / title / limit ─────────────────────────────────────────────────────

export const newTree: DotTreeNode = {
	id: "new",
	label: "new",
	description: "Start a new chat session",
	kind: "action",
};

export function createTitleTree(currentTitle: string | null): DotTreeNode {
	return {
		id: "title",
		label: "title",
		description: currentTitle ? `Current: ${currentTitle}` : "Enter session title",
		kind: "text",
	};
}

export function createLimitTree(currentLimit: number | null): DotTreeNode {
	const desc = currentLimit != null ? `Current: ${currentLimit}` : "Set context limit";
	return {
		id: "limit",
		label: "limit",
		description: desc,
		kind: "text",
	};
}

// ── model ───────────────────────────────────────────────────────────────────

export function createModelTree(modelList: ModelListItem[] | null): DotTreeNode {
	return {
		id: "model",
		label: "model",
		description: "Switch the AI model",
		kind: "menu",
		children: (f: string) => {
			if (!modelList) return [{ id: "model.loading", label: "Loading models...", kind: "action" as const }];
			if (modelList.length === 0) return [{ id: "model.empty", label: "No models available", kind: "action" as const }];
			const filtered = filterList(
				modelList,
				f,
				(m) => m.id,
				(m) => m.index,
			);
			if (filtered.length === 0) return [{ id: "model.none", label: "No matching models", kind: "action" as const }];
			const padWidth = String(Math.max(...filtered.map((m) => m.index))).length;
			return filtered.map((m) => ({
				id: `model.${m.index}`,
				label: `${String(m.index).padStart(padWidth, " ")}: ${m.id}`,
				description: m.contextWindow > 0 ? `(${m.cost}, ${formatContextWindow(m.contextWindow)})` : `(${m.cost})`,
				commitValue: String(m.index),
				kind: "action" as const,
			}));
		},
	};
}

// ── provider ────────────────────────────────────────────────────────────────

export function createProviderTree(providerList: ProviderListItem[] | null): DotTreeNode {
	return {
		id: "provider",
		label: "provider",
		description: "Switch the AI provider",
		kind: "menu",
		children: (f: string) => {
			if (!providerList) return [{ id: "provider.loading", label: "Loading providers...", kind: "action" as const }];
			if (providerList.length === 0)
				return [{ id: "provider.empty", label: "No authenticated providers", kind: "action" as const }];
			const filtered = filterList(
				providerList,
				f,
				(p) => p.id,
				(p) => p.index,
			);
			if (filtered.length === 0) return [{ id: "provider.none", label: "No matching providers", kind: "action" as const }];
			return filtered.map((p) => ({
				id: `provider.${p.index}`,
				label: `${p.index}: ${p.id}`,
				description: p.runtimeSupported ? undefined : "runtime not supported yet",
				commitValue: String(p.index),
				kind: "action" as const,
			}));
		},
	};
}

// ── session ─────────────────────────────────────────────────────────────────

interface SessionItem {
	index: number;
	id: string;
	title: string | null;
	updatedAt: string;
	owned: boolean;
}

export function createSessionTree(
	sessions: SessionItem[] | null,
	getSessionId: () => string | null,
	sessionLocked: boolean,
): DotTreeNode {
	return {
		id: "session",
		label: "session",
		description: "Switch or manage sessions",
		kind: "menu",
		children: (f: string) => {
			if (!sessions) return [{ id: "session.loading", label: "Loading sessions...", kind: "action" as const }];
			if (sessions.length === 0) return [{ id: "session.empty", label: "No sessions", kind: "action" as const }];
			const filtered = filterList(
				sessions,
				f,
				(s) => s.title ?? "",
				(s) => s.index,
			);
			if (filtered.length === 0) return [{ id: "session.none", label: "No matching sessions", kind: "action" as const }];
			return filtered.map((s) => {
				const isCurrentSession = s.id === getSessionId();
				const isOwnedByOther = s.owned && !(isCurrentSession && !sessionLocked);
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
				const title = s.title || "untitled";
				const segments: { text: string; muted?: boolean }[] = [
					{ text: ` ${s.index}: ` },
					{ text: localTime, muted: true },
					{ text: " — " },
					{ text: title },
				];
				if (isOwnedByOther) segments.push({ text: " (active in another tab)", muted: true });
				if (isCurrentSession && !sessionLocked) segments.push({ text: " (this session)", muted: true });
				return {
					id: `session.${s.index}`,
					label: `${s.index}: ${s.title ?? ""}`,
					description: `${localTime}${isOwnedByOther ? " (active in another tab)" : ""}${isCurrentSession && !sessionLocked ? " (this session)" : ""}`,
					segments,
					commitValue: String(s.index),
					kind: "action" as const,
				};
			});
		},
	};
}

// ── subagent ────────────────────────────────────────────────────────────────

interface SubagentItem {
	index: number;
	title: string;
	sessionId: string;
}

export function createSubagentTree(subagents: SubagentItem[] | null): DotTreeNode {
	return {
		id: "subagent",
		label: "subagent",
		description: "Browse subagent sessions",
		kind: "menu",
		children: (f: string) => {
			if (!subagents) return [{ id: "subagent.loading", label: "Loading subagents...", kind: "action" as const }];
			if (subagents.length === 0) return [{ id: "subagent.empty", label: "No subagent sessions", kind: "action" as const }];
			const filtered = filterList(
				subagents,
				f,
				(s) => s.title,
				(s) => s.index,
			);
			if (filtered.length === 0) return [{ id: "subagent.none", label: "No matching subagents", kind: "action" as const }];
			return filtered.map((s) => ({
				id: `subagent.${s.index}`,
				label: `${s.index}: ${s.title}`,
				commitValue: String(s.index),
				kind: "action" as const,
			}));
		},
	};
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pf(items: DotTreeNode[], filter: string): DotTreeNode[] {
	if (!filter) return items;
	return items.filter((n) => n.label.toLowerCase().startsWith(filter.toLowerCase()));
}

function filterList<T>(items: T[], filter: string, selectId: (item: T) => string, getIndex: (item: T) => number): T[] {
	if (!filter) return items;
	// Numeric filter: match by index contains
	if (/^\d+$/.test(filter)) {
		return items.filter((item) => String(getIndex(item)).includes(filter));
	}
	// Text filter: fuzzy match
	return fuzzyFilterAndSort(items, filter, selectId);
}
