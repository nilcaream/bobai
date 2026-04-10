import type { CompactionDetail, CompactionStats, ContextMessage } from "./formatUtils";
import { formatCompactionSummary, formatToolHeader, truncateChars, truncateContent } from "./formatUtils";
import { Markdown } from "./Markdown";

export type ContextViewMode = "raw" | "compaction";

interface ContextRenderOptions {
	mode: ContextViewMode;
	lineLimit: number;
	details: Record<string, CompactionDetail> | null;
	charsPerToken?: number;
}

function renderMessagePanels(
	msgs: ContextMessage[],
	opts: ContextRenderOptions,
	startKey: number,
): { elements: React.ReactNode[]; nextKey: number } {
	const elements: React.ReactNode[] = [];
	let key = startKey;

	// Build a map from tool_call_id -> tool function name
	const toolCallNames = new Map<string, string>();
	for (const msg of msgs) {
		if (msg.role === "assistant" && msg.metadata?.tool_calls) {
			const calls = msg.metadata.tool_calls as Array<{ id: string; function: { name: string } }>;
			for (const tc of calls) {
				toolCallNames.set(tc.id, tc.function.name);
			}
		}
	}

	const isRaw = opts.mode === "raw";
	const headerSuffix = isRaw ? "" : " | excluded";

	for (const msg of msgs) {
		if (msg.role === "system") {
			const indexPrefix = !isRaw && msg.messageIndex !== undefined ? `#${msg.messageIndex} ` : "";
			elements.push(
				<div key={key++} className="panel panel--context">
					<div className="context-header">{`${indexPrefix}system${headerSuffix}`}</div>
					<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content?.trim()}</pre>
				</div>,
			);
		} else if (msg.role === "user") {
			const indexPrefix = !isRaw && msg.messageIndex !== undefined ? `#${msg.messageIndex} ` : "";
			elements.push(
				<div key={key++} className="panel panel--context">
					<div className="context-header">{`${indexPrefix}user${headerSuffix}`}</div>
					<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content?.trim()}</pre>
				</div>,
			);
		} else if (msg.role === "assistant") {
			const toolCalls = msg.metadata?.tool_calls as
				| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
				| undefined;

			if (msg.content) {
				const indexPrefix = !isRaw && msg.messageIndex !== undefined ? `#${msg.messageIndex} ` : "";
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">{`${indexPrefix}assistant${headerSuffix}`}</div>
						<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content.trim()}</pre>
					</div>,
				);
			}

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					const callBody = `${tc.function.name}(${tc.function.arguments})`;
					elements.push(
						<div key={key++} className="panel panel--context">
							<div className="context-header">{isRaw ? `assistant | ${tc.id}` : `assistant | ${tc.id} | excluded`}</div>
							<pre className="context-body">{isRaw ? truncateChars(callBody, 512) : callBody}</pre>
						</div>,
					);
				}
			}
		} else if (msg.role === "tool") {
			const toolCallId = msg.metadata?.tool_call_id as string | undefined;
			const toolName = toolCallId ? (toolCallNames.get(toolCallId) ?? "unknown") : "unknown";
			const rawContent = (msg.content || "(no output)").trim();

			let header: string;
			if (isRaw) {
				header = `tool | ${toolCallId ?? ""} | ${toolName}`;
			} else {
				const detail = toolCallId && opts.details ? opts.details[toolCallId] : undefined;
				header = formatToolHeader(toolCallId ?? "", toolName, detail, msg.messageIndex, opts.charsPerToken);
			}

			elements.push(
				<div key={key++} className="panel panel--context">
					<div className="context-header">{header}</div>
					<pre className="context-body">{isRaw ? truncateContent(rawContent, opts.lineLimit) : rawContent}</pre>
				</div>,
			);
		}
	}

	return { elements, nextKey: key };
}

export function ContextMessageList({
	contextMessages,
	compactionData,
	viewMode,
	lineLimit,
}: {
	contextMessages: ContextMessage[] | null;
	compactionData: {
		messages: ContextMessage[];
		stats: CompactionStats | null;
		details: Record<string, CompactionDetail> | null;
	} | null;
	viewMode: "context" | "compaction";
	lineLimit: number;
}) {
	if (viewMode === "context") {
		if (!contextMessages) {
			return (
				<div key="empty" className="panel panel--context">
					No session context available.
				</div>
			);
		}
		const { elements } = renderMessagePanels(contextMessages, { mode: "raw", lineLimit, details: null }, 0);
		return <>{elements}</>;
	}

	// compaction mode
	if (!compactionData) {
		return (
			<div key="empty" className="panel panel--context">
				No compaction data available.
			</div>
		);
	}
	const { elements } = renderMessagePanels(
		compactionData.messages,
		{ mode: "compaction", lineLimit, details: compactionData.details, charsPerToken: compactionData.stats?.charsPerToken },
		0,
	);
	return (
		<>
			{elements}
			{viewMode === "compaction" && compactionData?.stats && (
				<div className="panel panel--context">
					<div className="context-header">compaction summary</div>
					<div className="context-body">
						<Markdown>{formatCompactionSummary(compactionData.stats)}</Markdown>
					</div>
				</div>
			)}
		</>
	);
}
