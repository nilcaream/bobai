import type { Database } from "bun:sqlite";
import { send } from "./protocol";
import type { Message, Provider } from "./provider/provider";
import { ProviderError } from "./provider/provider";
import { appendMessage, createSession, getMessages, getSession } from "./session/repository";
import { SYSTEM_PROMPT } from "./system-prompt";

export interface PromptRequest {
	ws: { send: (msg: string) => void };
	db: Database;
	provider: Provider;
	model: string;
	text: string;
	sessionId?: string;
}

export async function handlePrompt(req: PromptRequest) {
	const { ws, db, provider, model, text, sessionId } = req;

	let currentSessionId: string | undefined;
	let fullResponse = "";

	try {
		// Resolve or create session
		if (sessionId) {
			const session = getSession(db, sessionId);
			if (!session) {
				send(ws, { type: "error", message: `Session not found: ${sessionId}` });
				return;
			}
			currentSessionId = sessionId;
		} else {
			const session = createSession(db, SYSTEM_PROMPT);
			currentSessionId = session.id;
		}

		// Persist the user message
		appendMessage(db, currentSessionId, "user", text);

		// Load full conversation history
		const stored = getMessages(db, currentSessionId);
		const messages: Message[] = stored.map((m) => ({ role: m.role, content: m.content }));

		// Stream from provider
		for await (const chunk of provider.stream({ model, messages })) {
			fullResponse += chunk;
			send(ws, { type: "token", text: chunk });
		}

		// Persist the assistant response
		appendMessage(db, currentSessionId, "assistant", fullResponse);

		send(ws, { type: "done", sessionId: currentSessionId });
	} catch (err) {
		if (currentSessionId && fullResponse) {
			appendMessage(db, currentSessionId, "assistant", fullResponse);
		}
		const message =
			err instanceof ProviderError ? `Provider error (${err.status}): ${err.body}` : "Unexpected error during generation";
		send(ws, { type: "error", message });
	}
}
