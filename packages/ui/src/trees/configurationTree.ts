import type { DotTreeNode } from "../DotCommandTree";

function fieldChildren(): DotTreeNode[] {
	return [
		{
			id: "config.debug",
			label: "debug",
			description: "Enable or disable debug mode (true | false)",
			kind: "menu",
			children: () => [
				{
					id: "config.debug.true",
					label: "true",
					description: "Enable debug mode",
					kind: "action",
				},
				{
					id: "config.debug.false",
					label: "false",
					description: "Disable debug mode",
					kind: "action",
				},
			],
		},
		{
			id: "config.provider",
			label: "provider",
			description: "Enter a provider name or index",
			kind: "text",
		},
		{
			id: "config.model",
			label: "model",
			description: "Enter a model name or index",
			kind: "text",
		},
		{
			id: "config.port",
			label: "port",
			description: "Enter a port number (1–65535)",
			kind: "text",
		},
		{
			id: "config.maxIterations",
			label: "maxIterations",
			description: "Enter a positive integer",
			kind: "text",
		},
	];
}

export const configurationTree: DotTreeNode = {
	id: "config",
	label: "configuration",
	description: "Manage global and project configuration",
	kind: "menu",
	children: () => [
		{
			id: "config.project",
			label: "project",
			description: "Manage project-level configuration",
			kind: "menu",
			children: fieldChildren,
		},
		{
			id: "config.global",
			label: "global",
			description: "Manage global configuration",
			kind: "menu",
			children: fieldChildren,
		},
	],
};
