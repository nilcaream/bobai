import type { DotTreeNode } from "./DotCommandTree";
import { nodeCommitValue, type ResolvedDotState } from "./DotCommandTree";

export interface DotCommandNavigatorProps {
	state: ResolvedDotState | null;
	/** Called when the user clicks a selectable option. Receives the full commit path. */
	onCommit?: (commitPath: string) => void;
}

export function DotCommandNavigator({ state, onCommit }: DotCommandNavigatorProps) {
	if (!state) return null;

	const { visible, filter, value, currentNode } = state;

	if (currentNode.kind === "text") {
		const hint = currentNode.description ?? `Enter a value for ${currentNode.label}`;
		const fullText = value ? `${hint} ${value}` : hint;
		return (
			<div>
				{currentNode.label} <span className="slash-skill-desc">— {fullText}</span>
			</div>
		);
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
				<OptionRow key={child.id} node={child} state={state} onCommit={onCommit} />
			))}
		</>
	);
}

function OptionRow({
	node,
	state,
	onCommit,
}: {
	node: DotTreeNode;
	state: ResolvedDotState;
	onCommit?: (commitPath: string) => void;
}) {
	const handleClick = () => {
		if (!onCommit) return;
		const path = [...state.path, nodeCommitValue(node)];
		onCommit(path.join(" "));
	};

	return (
		<div
			onClick={handleClick}
			onKeyDown={(e) => {
				if (e.key === "Enter") handleClick();
			}}
			tabIndex={0}
			role="option"
			style={{ cursor: onCommit ? "pointer" : "default" }}
		>
			{node.segments
				? node.segments.map((seg, i) => {
						const key = `${i}-${seg.text.slice(0, 20)}`;
						return (
							<span key={key} className={seg.muted ? "slash-skill-desc" : undefined}>
								{seg.text}
							</span>
						);
					})
				: null}
			{!node.segments && node.label}
			{!node.segments && node.description ? <span className="slash-skill-desc"> — {node.description}</span> : null}
		</div>
	);
}
