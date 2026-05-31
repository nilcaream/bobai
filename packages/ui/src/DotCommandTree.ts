export type DotNodeKind = "menu" | "text" | "action";

export interface DotTreeNode {
	id: string;
	label: string;
	description?: string;
	/** Fine-grained text segments for interleaved normal/muted styling. Takes precedence over label+description. */
	segments?: { text: string; muted?: boolean }[];
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

/**
 * Builds the commit path for Enter key submission — no row was clicked, so we
 * resolve the current filter against visible children.
 *
 * Numeric filters are resolved by exact index match against the first number in
 * the child's label (e.g. filter "3" matches label " 3: glm-5").
 * Text filters fall through to the raw filter for server-side resolution.
 */
export function buildEnterCommitPath(state: ResolvedDotState): string {
	const parts = [...state.path];
	if (state.value) {
		parts.push(state.value);
	} else if (state.filter) {
		const child = state.visible.length > 0 ? resolveVisibleChild(state.filter, state.visible) : undefined;
		parts.push(child ? nodeCommitValue(child) : state.filter);
	}
	return parts.join(" ");
}

function resolveVisibleChild(filter: string, children: DotTreeNode[]): DotTreeNode | undefined {
	if (!filter) return undefined;
	if (/^\d+$/.test(filter)) {
		const idx = Number.parseInt(filter, 10);
		return children.find((c) => {
			const firstWord = c.label.trim().split(/\s+/)[0] ?? "";
			const num = Number.parseInt(firstWord.replace(/:$/, ""), 10);
			return num === idx;
		});
	}
	// Text filter: children are already sorted by fuzzy relevance via the
	// tree's children callback. Use the first child as the best match.
	// Consistent with .session / .model behavior (fuzzyFilterAndSort → [0]).
	if (children.length > 0) return children[0];
	return undefined;
}
