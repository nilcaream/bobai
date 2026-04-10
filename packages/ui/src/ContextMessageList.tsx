import type { CompactionDetail, ContextMessage } from "./formatUtils";
import { formatToolHeader, truncateChars, truncateContent } from "./formatUtils";

export type ContextViewMode = "raw" | "compaction";

interface ContextRenderOptions {
	mode: ContextViewMode;
	lineLimit: number;
	details: Record<string, CompactionDetail> | null;
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
	const headerSuffix = isRaw ? "" : " | excluded from compaction";

	for (const msg of msgs) {
		if (msg.role === "system") {
			elements.push(
				<div key={key++} className="panel panel--context">
					<div className="context-header">{`system${headerSuffix}`}</div>
					<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content?.trim()}</pre>
				</div>,
			);
		} else if (msg.role === "user") {
			elements.push(
				<div key={key++} className="panel panel--context">
					<div className="context-header">{`user${headerSuffix}`}</div>
					<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content?.trim()}</pre>
				</div>,
			);
		} else if (msg.role === "assistant") {
			const toolCalls = msg.metadata?.tool_calls as
				| Array<{ id: string; type: string; function: { name: string; arguments: string } }>
				| undefined;

			if (msg.content) {
				elements.push(
					<div key={key++} className="panel panel--context">
						<div className="context-header">{`assistant${headerSuffix}`}</div>
						<pre className="context-body">{isRaw ? truncateContent(msg.content, opts.lineLimit) : msg.content.trim()}</pre>
					</div>,
				);
			}

			if (toolCalls && toolCalls.length > 0) {
				for (const tc of toolCalls) {
					const callBody = `${tc.function.name}(${tc.function.arguments})`;
					elements.push(
						<div key={key++} className="panel panel--context">
							<div className="context-header">
								{isRaw ? `assistant | ${tc.id}` : `assistant | ${tc.id} | excluded from compaction`}
							</div>
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
				header = formatToolHeader(toolCallId ?? "", toolName, detail);
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
		stats: import("./formatUtils").CompactionStats | null;
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
		{ mode: "compaction", lineLimit, details: compactionData.details },
		0,
	);
	return <>{elements}</>;
}
