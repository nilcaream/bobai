import fs from "node:fs";
import path from "node:path";
import { localTimestamp } from "../log/logger";
import type { AssistantMessage, Message } from "../provider/provider";

/** Dump code prefix — matches the call site context. */
export type DumpCode = "pre" | "emg";

export interface CompactionDumpOptions {
	logDir: string;
	before: Message[];
	afterCompaction: Message[];
	/** Post-eviction messages. File only written when provided AND differs from afterCompaction. */
	afterEviction?: Message[];
	code: DumpCode;
	/**
	 * Opaque scope string identifying the dump context.
	 * - `"global"` — global / shared context
	 * - `"514cc003"` — a session
	 * - `"514cc003-12345678"` — a subagent within a session
	 *
	 * Callers should not parse this value.
	 */
	scope: string;
	/** When false, skip writing entirely. */
	debug: boolean;
}

export interface CompactionDumpResult {
	preFile: string;
	postFile: string;
	evictionFile: string;
}

const EMPTY_RESULT: CompactionDumpResult = { preFile: "", postFile: "", evictionFile: "" };

/**
 * Format a single message for human-readable dump output.
 */
export function formatMessageForDump(msg: Message): string {
	if (msg.role === "tool") {
		const toolMsg = msg as { role: "tool"; content: string; tool_call_id: string };
		return `role: tool\ntool_call_id: ${toolMsg.tool_call_id}\n\n${toolMsg.content}`;
	}

	if (msg.role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
			const calls = assistantMsg.tool_calls
				.map((tc) => `tool_call: ${tc.id} ${tc.function.name}(${tc.function.arguments})`)
				.join("\n");
			return `role: assistant\n${calls}\n\n${assistantMsg.content ?? ""}`;
		}
		return `role: assistant\n\n${assistantMsg.content ?? ""}`;
	}

	// system or user
	return `role: ${msg.role}\n\n${msg.content}`;
}

/**
 * Build a dump filename following the unified format:
 * `debug-<date>-<time>-<scope>-<code>.txt`
 */
function dumpFilename(ts: string, scope: string, code: string): string {
	const date = ts.slice(0, 8);
	const time = ts.slice(8);
	return `debug-${date}-${time}-${scope}-${code}.txt`;
}

function formatDump(messages: Message[]): string {
	const sections: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		sections.push(`--- message ${i} ---`);
		sections.push(formatMessageForDump(msg));
	}
	return sections.join("\n");
}

/**
 * Write compaction/eviction dump files.
 *
 * Produces up to 3 files:
 * - `*-<code>0.txt` — original messages before compaction
 * - `*-<code>1.txt` — messages after compaction
 * - `*-<code>2.txt` — messages after eviction (only when eviction changed something)
 *
 * Filenames follow the format `debug-<date>-<time>-<scope>-<code>.txt`.
 *
 * Returns empty strings when `debug` is false, on write failure, or when a file was skipped.
 */
export function writeCompactionDump(options: CompactionDumpOptions): CompactionDumpResult {
	if (!options.debug) return EMPTY_RESULT;

	try {
		fs.mkdirSync(options.logDir, { recursive: true });

		const ts = localTimestamp().replace(/[-: .]/g, "");

		const preFilename = dumpFilename(ts, options.scope, `${options.code}0`);
		const postFilename = dumpFilename(ts, options.scope, `${options.code}1`);

		fs.writeFileSync(path.join(options.logDir, preFilename), formatDump(options.before));
		fs.writeFileSync(path.join(options.logDir, postFilename), formatDump(options.afterCompaction));

		let evictionFilename = "";
		if (options.afterEviction && options.afterEviction !== options.afterCompaction) {
			evictionFilename = dumpFilename(ts, options.scope, `${options.code}2`);
			fs.writeFileSync(path.join(options.logDir, evictionFilename), formatDump(options.afterEviction));
		}

		return { preFile: preFilename, postFile: postFilename, evictionFile: evictionFilename };
	} catch {
		return EMPTY_RESULT;
	}
}
