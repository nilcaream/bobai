export type DotNodeKind = "menu" | "text" | "action";

export interface DotTreeNode {
	id: string;
	label: string;
	description?: string;
	children?: () => DotTreeNode[];
	kind: DotNodeKind;
}

export interface ResolvedDotState {
	visible: DotTreeNode[];
	filter: string;
	value: string;
	path: string[];
	currentNode: DotTreeNode;
}

function prefixMatch(nodes: DotTreeNode[], filter: string): DotTreeNode[] {
	if (!filter) return nodes;
	const lower = filter.toLowerCase();
	return nodes.filter((n) => n.label.toLowerCase().startsWith(lower));
}

export function resolveDotTree(root: DotTreeNode, args: string): ResolvedDotState {
	const rawArgs = args ?? "";
	const endsWithSpace = rawArgs.endsWith(" ");
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);

	let currentNode = root;
	const path: string[] = [];
	let depth = 0;

	while (depth < tokens.length) {
		const token = tokens[depth] ?? "";
		const isLastToken = depth === tokens.length - 1;
		const children = currentNode.children?.() ?? [];

		if (currentNode.kind === "text") {
			const value = tokens.slice(depth).join(" ");
			return { visible: [], filter: "", value, path, currentNode };
		}

		if (currentNode.kind === "action") {
			return { visible: [], filter: "", value: "", path, currentNode };
		}

		if (children.length === 0) {
			const value = tokens.slice(depth).join(" ");
			return { visible: [], filter: "", value, path, currentNode };
		}

		const shouldCommit = isLastToken ? endsWithSpace : true;

		if (!shouldCommit) {
			const matches = prefixMatch(children, token);
			return { visible: matches, filter: token, value: "", path, currentNode };
		}

		const matches = prefixMatch(children, token);

		if (matches.length === 1) {
			currentNode = matches[0] as DotTreeNode;
			path.push(currentNode.label);
			depth++;
		} else {
			return { visible: matches.length > 0 ? matches : children, filter: token, value: "", path, currentNode };
		}
	}

	const children = currentNode.children?.() ?? [];

	if (currentNode.kind === "text") {
		return { visible: [], filter: "", value: "", path, currentNode };
	}

	if (currentNode.kind === "action") {
		return { visible: [], filter: "", value: "", path, currentNode };
	}

	return { visible: children, filter: "", value: "", path, currentNode };
}
