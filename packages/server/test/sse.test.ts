import { describe, expect, test } from "bun:test";
import { parseSSE } from "../src/provider/sse";

function toStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("parseSSE", () => {
	test("parses single data line", async () => {
		const stream = toStream('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([{ choices: [{ delta: { content: "hello" } }] }]);
	});

	test("parses multiple events", async () => {
		const stream = toStream(
			'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
		);
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(2);
	});

	test("stops on [DONE] sentinel", async () => {
		const stream = toStream('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});

	test("skips empty lines and non-data lines", async () => {
		const stream = toStream(': comment\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});

	test("handles chunked data split across stream reads", async () => {
		const full = 'data: {"choices":[{"delta":{"content":"split"}}]}\n\n';
		const mid = Math.floor(full.length / 2);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(full.slice(0, mid)));
				controller.enqueue(new TextEncoder().encode(full.slice(mid)));
				controller.close();
			},
		});
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toHaveLength(1);
	});

	test("parses standard SSE blocks with event and data lines", async () => {
		const stream = toStream(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n' +
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([{ type: "message_start", message: { id: "m1" } }, { type: "message_stop" }]);
	});

	test("joins multiple data lines within one SSE event", async () => {
		const stream = toStream('event: x\ndata: {"a":\ndata: 1}\n\n');
		const chunks: unknown[] = [];
		for await (const chunk of parseSSE(stream)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([{ a: 1 }]);
	});

	test("throws error when stream fails mid-read", async () => {
		const errorStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
				controller.error(new Error("Network connection reset"));
			},
		});

		let errorThrown = false;
		const chunks: unknown[] = [];

		try {
			for await (const chunk of parseSSE(errorStream)) {
				chunks.push(chunk);
			}
		} catch (err) {
			errorThrown = true;
			expect((err as Error).message).toBe("Network connection reset");
		}

		expect(errorThrown).toBe(true);
	});

	test("throws error when stream connection is aborted", async () => {
		const abortController = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Simulate receiving some data then the connection being aborted
				controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'));
				// Signal abort (this simulates what fetch does when network drops)
				abortController.abort();
				// When fetch's signal is aborted, the reader throws an AbortError
				controller.error(new DOMException("The operation was aborted", "AbortError"));
			},
		});

		let errorThrown = false;
		try {
			for await (const _chunk of parseSSE(stream)) {
				// Do nothing, just consume
			}
		} catch (_err) {
			errorThrown = true;
		}

		expect(errorThrown).toBe(true);
	});
});
