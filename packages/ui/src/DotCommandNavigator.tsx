import type { ResolvedDotState } from "./DotCommandTree";

export interface DotCommandNavigatorProps {
	state: ResolvedDotState | null;
}

export function DotCommandNavigator({ state }: DotCommandNavigatorProps) {
	if (!state) return null;

	const { visible, filter, value, currentNode } = state;

	if (currentNode.kind === "text") {
		if (value) {
			return (
				<div>
					{currentNode.label} = {value}
				</div>
			);
		}
		return <div>{currentNode.description ?? `Enter a value for ${currentNode.label}`}</div>;
	}

	if (currentNode.kind === "action") {
		return (
			<div>
				{currentNode.label} — {currentNode.description ?? ""}
			</div>
		);
	}

	if (visible.length === 0) {
		if (filter) {
			return <div>No matching options</div>;
		}
		return null;
	}

	return (
		<>
			{visible.map((child) => (
				<div key={child.id}>
					{child.label}
					{child.description ? ` — ${child.description}` : ""}
				</div>
			))}
		</>
	);
}
