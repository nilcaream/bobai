import type { DotTreeNode } from "../DotCommandTree";
import { filterList, type ModelListItem, type ProviderListItem } from "./commandTrees";

/**
 * Builds the configuration command tree.
 *
 * The tree has 3 levels: scope → field → value.
 * Each level's children() callback filters by prefix match.
 *
 * Provider and model fields are dynamic — they use the same list data and
 * fuzzy filtering as the standalone .provider and .model commands.
 */

function matchesFilter(label: string, filter: string): boolean {
	if (!filter) return true;
	return label.toLowerCase().startsWith(filter.toLowerCase());
}

function filterNodes(nodes: DotTreeNode[], filter: string): DotTreeNode[] {
	if (!filter) return nodes;
	return nodes.filter((n) => matchesFilter(n.label, filter));
}

function valueNodes(values: [string, string][]): DotTreeNode[] {
	return values.map(([label, desc]) => ({
		id: `config.value.${label}`,
		label,
		description: desc,
		kind: "action" as const,
	}));
}

function formatContextWindow(cw: number): string {
	return `${Math.round(cw / 1000)}k`;
}

function formatCost(cost: string, contextWindow: number): string {
	if (contextWindow > 0) {
		return `${cost}, ${formatContextWindow(contextWindow)}`;
	}
	return cost;
}

export function createConfigurationTree(
	providerList: ProviderListItem[] | null,
	modelList: ModelListItem[] | null,
): DotTreeNode {
	function providerChildren(filter: string): DotTreeNode[] {
		if (!providerList) return [{ id: "config.provider.loading", label: "Loading providers...", kind: "action" as const }];
		if (providerList.length === 0)
			return [{ id: "config.provider.empty", label: "No authenticated providers", kind: "action" as const }];
		const filtered = filterList(
			providerList,
			filter,
			(p) => p.id,
			(p) => p.index,
		);
		if (filtered.length === 0) return [{ id: "config.provider.none", label: "No matching providers", kind: "action" as const }];
		return filtered.map((p) => ({
			id: `config.provider.${p.index}`,
			label: `${p.index}: ${p.id}`,
			description: p.runtimeSupported ? undefined : "runtime not supported yet",
			commitValue: p.id,
			kind: "action" as const,
		}));
	}

	function modelChildren(filter: string): DotTreeNode[] {
		if (!modelList) return [{ id: "config.model.loading", label: "Loading models...", kind: "action" as const }];
		if (modelList.length === 0) return [{ id: "config.model.empty", label: "No models available", kind: "action" as const }];
		const filtered = filterList(
			modelList,
			filter,
			(m) => m.id,
			(m) => m.index,
		);
		if (filtered.length === 0) return [{ id: "config.model.none", label: "No matching models", kind: "action" as const }];
		const padWidth = String(Math.max(...filtered.map((m) => m.index))).length;
		return filtered.map((m) => ({
			id: `config.model.${m.index}`,
			label: `${String(m.index).padStart(padWidth, " ")}: ${m.id}`,
			description: formatCost(m.cost, m.contextWindow),
			commitValue: m.id,
			kind: "action" as const,
		}));
	}

	function fieldNodes(): DotTreeNode[] {
		return [
			{
				id: "config.field.debug",
				label: "debug",
				description: "Enable or disable debug mode (true | false)",
				kind: "menu" as const,
				children: (f: string) =>
					filterNodes(
						valueNodes([
							["true", "Enable debug mode"],
							["false", "Disable debug mode"],
						]),
						f,
					),
			},
			{
				id: "config.field.provider",
				label: "provider",
				description: "Select provider",
				kind: "menu" as const,
				children: providerChildren,
			},
			{
				id: "config.field.model",
				label: "model",
				description: "Select model",
				kind: "menu" as const,
				children: modelChildren,
			},
			{
				id: "config.field.port",
				label: "port",
				description: "Enter a port number (1–65535)",
				kind: "text" as const,
			},
			{
				id: "config.field.maxIterations",
				label: "maxIterations",
				description: "Enter the maximum number of agent loop iterations",
				kind: "text" as const,
			},
		];
	}

	return {
		id: "config",
		label: "configuration",
		description: "Manage global and project configuration",
		kind: "menu",
		children: (filter: string) =>
			filterNodes(
				[
					{
						id: "config.project",
						label: "project",
						description: "Manage project-level configuration",
						kind: "menu" as const,
						children: (f: string) => filterNodes(fieldNodes(), f),
					},
					{
						id: "config.global",
						label: "global",
						description: "Manage global configuration",
						kind: "menu" as const,
						children: (f: string) => filterNodes(fieldNodes(), f),
					},
				],
				filter,
			),
	};
}
