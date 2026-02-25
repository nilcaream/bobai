import type { ClientMessage } from "./protocol";
import { send } from "./protocol";
import type { Message, Provider } from "./provider/provider";
import { ProviderError } from "./provider/provider";

export async function handlePrompt(ws: { send: (msg: string) => void }, msg: ClientMessage, provider: Provider, model: string) {
	try {
		const messages: Message[] = [
			{ role: "system", content: "You are Bob AI, a coding assistant." },
			{ role: "user", content: msg.text },
		];

		for await (const text of provider.stream({ model, messages })) {
			send(ws, { type: "token", text });
		}
		send(ws, { type: "done" });
	} catch (err) {
		const message =
			err instanceof ProviderError ? `Provider error (${err.status}): ${err.body}` : "Unexpected error during generation";
		send(ws, { type: "error", message });
	}
}
