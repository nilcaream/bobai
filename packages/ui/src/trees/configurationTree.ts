import type { DotTreeNode } from "../DotCommandTree";

/**
 * Builds the configuration command tree.
 *
 * The tree has 3 levels: scope → field → value
 * Each level's children() callback filters by prefix match.
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
			description: "Enter a provider name or index",
			kind: "text" as const,
		},
		{
			id: "config.field.model",
			label: "model",
			description: "Enter a model name or index",
			kind: "text" as const,
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

export const configurationTree: DotTreeNode = {
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
