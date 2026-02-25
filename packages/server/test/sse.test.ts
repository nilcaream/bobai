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
});
