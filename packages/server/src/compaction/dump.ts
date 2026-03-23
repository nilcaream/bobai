import fs from "node:fs";
import path from "node:path";
import { localTimestamp } from "../log/logger";
import type { AssistantMessage, Message } from "../provider/provider";

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

function dumpFilename(suffix: string, index: number): string {
	const ts = localTimestamp().replace(/[-: .]/g, "");
	const date = ts.slice(0, 8);
	const time = ts.slice(8);
	const rand = Math.random().toString(36).substring(2, 6);
	return `comp-${date}_${time}-${suffix}-${rand}-${index}.txt`;
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
 * Write paired pre/post compaction dump files.
 * Returns the filenames of the pre and post files, or empty strings on failure.
 */
export function writeCompactionDump(
	logDir: string,
	before: Message[],
	after: Message[],
	suffix: string,
): { preFile: string; postFile: string } {
	try {
		fs.mkdirSync(logDir, { recursive: true });

		const preFilename = dumpFilename(suffix, 0);
		const postFilename = dumpFilename(suffix, 1);

		fs.writeFileSync(path.join(logDir, preFilename), formatDump(before));
		fs.writeFileSync(path.join(logDir, postFilename), formatDump(after));

		return { preFile: preFilename, postFile: postFilename };
	} catch {
		return { preFile: "", postFile: "" };
	}
}
