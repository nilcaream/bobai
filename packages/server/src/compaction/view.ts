import type { Message } from "../provider/provider";
import type { StoredMessage } from "../session/repository";

/**
 * Maps an evicted (post-compaction + post-eviction) `Message[]` back to
 * `StoredMessage`-like objects for the compaction view UI.
 *
 * Compaction preserves array length, so `compacted[i]` has a 1:1
 * correspondence with the original `messages` input (index 0 is the
 * system prompt, so `compacted[i]` → `conversationMessages[i-1]`).
 *
 * Eviction then removes messages, breaking positional correspondence.
 * This function uses object-reference identity to map surviving messages
 * back to their original `StoredMessage`, falling back to a synthetic
 * entry for messages rebuilt by eviction (e.g. filtered assistant tool_calls).
 */
export function mapEvictedToStored(
	compacted: Message[],
	evicted: Message[],
	conversationMessages: StoredMessage[],
	sessionId: string,
): StoredMessage[] {
	// Build an identity map: compacted Message object → original StoredMessage.
	const storedByRef = new Map<object, StoredMessage>();
	for (let j = 1; j < compacted.length; j++) {
		const stored = conversationMessages[j - 1];
		if (stored) storedByRef.set(compacted[j], stored);
	}

	return evicted.map((m, i) => {
		if (i === 0 && m.role === "system") {
			return {
				id: "system-dynamic",
				sessionId,
				role: "system" as const,
				content: m.content,
				createdAt: new Date().toISOString(),
				sortOrder: -1,
				metadata: null,
			};
		}
		if (m.role === "tool") {
			const toolMsg = m as { role: "tool"; content: string; tool_call_id: string };
			// Find original stored message by tool_call_id to preserve metadata
			const original = conversationMessages.find((s) => s.role === "tool" && s.metadata?.tool_call_id === toolMsg.tool_call_id);
			return {
				...(original ?? { id: `compacted-${i}`, sessionId, role: "tool" as const, createdAt: "", sortOrder: i }),
				content: toolMsg.content,
				metadata: { ...original?.metadata, tool_call_id: toolMsg.tool_call_id },
			};
		}
		// Look up the original StoredMessage by object reference.
		// Messages rebuilt by eviction (e.g. filtered assistant tool_calls)
		// won't be in the map — use a synthetic fallback with the actual content.
		const original = storedByRef.get(m);
		if (original) {
			return { ...original, content: (m as { content: string }).content ?? original.content };
		}
		return {
			id: `evicted-${i}`,
			sessionId,
			role: m.role as StoredMessage["role"],
			content: (m as { content: string }).content ?? "",
			createdAt: "",
			sortOrder: i,
			metadata: null,
		};
	});
}
