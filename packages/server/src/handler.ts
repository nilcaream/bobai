import type { ClientMessage } from "./protocol";
import { send } from "./protocol";

const STUB_RESPONSE = "This is a stub response from Bob AI.";

export async function handlePrompt(
	ws: { send: (msg: string) => void },
	_msg: ClientMessage,
) {
	for (const word of STUB_RESPONSE.split(" ")) {
		send(ws, { type: "token", text: `${word} ` });
		await Bun.sleep(10);
	}
	send(ws, { type: "done" });
}
