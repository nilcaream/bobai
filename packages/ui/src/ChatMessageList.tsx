import { formatMsgSummary, groupParts } from "./formatUtils";
import { Markdown } from "./Markdown";
import type { Message, SubagentInfo } from "./protocol";
import { ToolPanel } from "./ToolPanel";

export function ChatMessageList({
	messages,
	subagents,
	isStreaming,
	viewingSubagentId,
	parentId,
	peekSubagentWithScroll,
	peekSubagentFromDbWithScroll,
}: {
	messages: Message[];
	subagents: SubagentInfo[];
	isStreaming: boolean;
	viewingSubagentId: string | null;
	parentId: string | null;
	peekSubagentWithScroll: (sessionId: string) => void;
	peekSubagentFromDbWithScroll: (sessionId: string) => void;
}) {
	const elements: React.ReactNode[] = [];
	let key = 0;

	for (let m = 0; m < messages.length; m++) {
		const msg = messages[m];
		if (!msg) continue;
		const isLastMsg = m === messages.length - 1;
		if (msg.role === "user") {
			const isSubagentView = viewingSubagentId !== null || parentId !== null;
			elements.push(
				<div key={key++} className="panel panel--user">
					{isSubagentView ? <Markdown>{msg.text}</Markdown> : msg.text}
					<div className="panel-status">{msg.timestamp}</div>
				</div>,
			);
			continue;
		}

		const panels = groupParts(msg.parts);
		const msgSummary = formatMsgSummary(msg);
		for (let i = 0; i < panels.length; i++) {
			const panel = panels[i];
			if (!panel) continue;
			const isLast = i === panels.length - 1;

			if (panel.type === "text") {
				elements.push(
					<div key={key++} className="panel panel--assistant">
						<Markdown>{panel.content}</Markdown>
						{isLast && msg.timestamp && (
							<div className="panel-status">
								{msg.timestamp}
								{msgSummary}
							</div>
						)}
					</div>,
				);
			} else {
				const linkedSubagent = subagents.find((s) => s.toolCallId === panel.id);
				const subagentSessionId = linkedSubagent?.sessionId ?? panel.subagentSessionId;
				const onNavigate = subagentSessionId
					? () => {
							if (linkedSubagent?.status === "running") {
								peekSubagentWithScroll(subagentSessionId);
							} else {
								peekSubagentFromDbWithScroll(subagentSessionId);
							}
						}
					: undefined;
				const shouldObserve = isStreaming && isLastMsg && !panel.completed;

				elements.push(
					<ToolPanel key={key++} content={panel.content} onNavigate={onNavigate} observe={shouldObserve}>
						<Markdown>{panel.content}</Markdown>
						{panel.summary && <div className="panel-status">{panel.summary}</div>}
						{!panel.summary && isLast && msg.timestamp && (
							<div className="panel-status">
								{msg.timestamp}
								{msgSummary}
							</div>
						)}
					</ToolPanel>,
				);
			}
		}
	}

	return <>{elements}</>;
}
