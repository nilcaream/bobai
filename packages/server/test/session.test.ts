import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

describe("prompt session", () => {
	let server: ReturnType<typeof Bun.serve>;
	let wsUrl: string;

	beforeAll(() => {
		server = createServer({ port: 0 });
		wsUrl = `ws://localhost:${server.port}/bobai/ws`;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("streams token messages then done in response to a prompt", async () => {
		const received: string[] = [];
		const ws = new WebSocket(wsUrl);

		const done = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
			};
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string) as { type: string; text?: string };
				received.push(msg.type);
				if (msg.type === "done") {
					ws.close();
				}
			};
			ws.onclose = () => resolve();
			ws.onerror = (err) => reject(err);
		});

		await done;

		expect(received.length).toBeGreaterThan(1);
		expect(received.at(-1)).toBe("done");
		expect(received.slice(0, -1).every((t) => t === "token")).toBe(true);
	});

	test("sends error message for unknown message type", async () => {
		const received: { type: string; message?: string }[] = [];
		const ws = new WebSocket(wsUrl);

		const done = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "unknown" }));
			};
			ws.onmessage = (event) => {
				received.push(JSON.parse(event.data as string));
				ws.close();
			};
			ws.onclose = () => resolve();
			ws.onerror = (err) => reject(err);
		});

		await done;

		expect(received[0]?.type).toBe("error");
	});
});
