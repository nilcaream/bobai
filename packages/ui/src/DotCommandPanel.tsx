import type { DotCommand, ParsedDotInput } from "./commandParser";
import { DotCommandNavigator } from "./DotCommandNavigator";
import type { DotTreeNode } from "./DotCommandTree";
import { resolveDotTree } from "./DotCommandTree";
import {
	createLimitTree,
	createModelTree,
	createProviderTree,
	createSessionTree,
	createSubagentTree,
	createTitleTree,
	newTree,
	viewTree,
} from "./trees/commandTrees";
import { configurationTree } from "./trees/configurationTree";

export type ModelListItem = { index: number; id: string; cost: string; contextWindow: number };
export type ProviderListItem = { index: number; id: string; runtimeSupported: boolean };

export function DotCommandPanel({
	parsed,
	modelList,
	providerList,
	sessionList,
	subagentList,
	getSessionId,
	sessionLocked,
	contextLimit,
	currentTitle,
	onCommit,
}: {
	parsed: ParsedDotInput | null;
	modelList: ModelListItem[] | null;
	providerList: ProviderListItem[] | null;
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null;
	subagentList: { index: number; title: string; sessionId: string }[] | null;
	getSessionId: () => string | null;
	sessionLocked: boolean;
	contextLimit: number | null;
	currentTitle: string | null;
	onCommit?: (commitPath: string) => void;
}) {
	if (!parsed) return null;

	let content: React.ReactNode;

	if (parsed.mode === "select") {
		content = renderSelectMode(parsed.matches);
	} else if (parsed.command) {
		const tree = resolveCommandTree(
			parsed.command,
			modelList,
			providerList,
			sessionList,
			subagentList,
			getSessionId,
			sessionLocked,
			contextLimit,
			currentTitle,
		);
		if (tree) {
			const treeState = resolveDotTree(tree, parsed.args);
			content = <DotCommandNavigator state={treeState} onCommit={onCommit} />;
		} else {
			return null;
		}
	}

	return (
		<div className="panel panel--dot">
			<div className="dot-scroll">{content}</div>
		</div>
	);
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

function resolveCommandTree(
	command: string,
	modelList: ModelListItem[] | null,
	providerList: ProviderListItem[] | null,
	sessionList: { index: number; id: string; title: string | null; updatedAt: string; owned: boolean }[] | null,
	subagentList: { index: number; title: string; sessionId: string }[] | null,
	getSessionId: () => string | null,
	sessionLocked: boolean,
	contextLimit: number | null,
	currentTitle: string | null,
): DotTreeNode | null {
	switch (command) {
		case "model":
			return createModelTree(modelList);
		case "provider":
			return createProviderTree(providerList);
		case "view":
			return viewTree;
		case "new":
			return newTree;
		case "title":
			return createTitleTree(currentTitle);
		case "limit":
			return createLimitTree(contextLimit);
		case "session":
			return createSessionTree(sessionList, getSessionId, sessionLocked);
		case "subagent":
			return createSubagentTree(subagentList);
		case "configuration":
			return configurationTree;
		default:
			return null;
	}
}
