export type DotNodeKind = "menu" | "text" | "action";

export interface DotTreeNode {
	id: string;
	label: string;
	description?: string;
	/** Returns children matching the filter. Call with "" to get all children. */
	children?: (filter: string) => DotTreeNode[];
	kind: DotNodeKind;
	/** Value submitted when this node is selected. Defaults to the first word of label. */
	commitValue?: string;
}

export interface ResolvedDotState {
	visible: DotTreeNode[];
	filter: string;
	value: string;
	path: string[];
	currentNode: DotTreeNode;
}

export function resolveDotTree(root: DotTreeNode, args: string): ResolvedDotState {
	const rawArgs = args ?? "";
	const endsWithSpace = rawArgs.endsWith(" ");
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);

	let currentNode: DotTreeNode = root;
	const path: string[] = [];
	let depth = 0;

	while (depth < tokens.length) {
		const token = tokens[depth] ?? "";
		const isLastToken = depth === tokens.length - 1;

		if (currentNode.kind === "text") {
			const value = tokens.slice(depth).join(" ");
			return { visible: [], filter: "", value, path, currentNode };
		}

		if (currentNode.kind === "action") {
			return { visible: [], filter: "", value: "", path, currentNode };
		}

		const matches = currentNode.children?.(token) ?? [];

		if (matches.length === 0) {
			return { visible: [], filter: token, value: "", path, currentNode };
		}

		const shouldCommit = isLastToken ? endsWithSpace : true;

		if (!shouldCommit) {
			return { visible: matches, filter: token, value: "", path, currentNode };
		}

		if (matches.length === 1) {
			currentNode = matches[0] as DotTreeNode;
			path.push(currentNode.label);
			depth++;
		} else {
			return { visible: matches, filter: token, value: "", path, currentNode };
		}
	}

	if (currentNode.kind === "text") {
		return { visible: [], filter: "", value: "", path, currentNode };
	}

	if (currentNode.kind === "action") {
		return { visible: [], filter: "", value: "", path, currentNode };
	}

	const children = currentNode.children?.("") ?? [];
	return { visible: children, filter: "", value: "", path, currentNode };
}

/** Extracts the commit value from a node — its commitValue field, or the first word of its label. */
export function nodeCommitValue(node: DotTreeNode): string {
	if (node.commitValue !== undefined) return node.commitValue;
	return node.label.split(/\s+/)[0] ?? node.label;
}

/** Builds the full commit path from a resolved state plus an optional selected child. */
export function commitPath(state: ResolvedDotState, selected?: DotTreeNode): string {
	const parts = [...state.path];
	if (state.value) {
		parts.push(state.value);
	} else if (selected) {
		parts.push(nodeCommitValue(selected));
	}
	return parts.join(" ");
}
