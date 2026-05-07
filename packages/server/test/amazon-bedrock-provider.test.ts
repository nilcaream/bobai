import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createAmazonBedrockProvider } from "../src/provider/amazon-bedrock";
import type { StreamEvent } from "../src/provider/provider";

// ---------------------------------------------------------------------------
// Binary event stream frame builder (test helper)
// ---------------------------------------------------------------------------

function buildEventStreamFrame(eventType: string, payload: unknown): Uint8Array {
	const encoder = new TextEncoder();
	const payloadBytes = encoder.encode(JSON.stringify(payload));

	// Build headers
	const eventTypeHeader = buildStringHeader(":event-type", eventType);
	const contentTypeHeader = buildStringHeader(":content-type", "application/json");
	const messageTypeHeader = buildStringHeader(":message-type", "event");
	const headers = concat(eventTypeHeader, contentTypeHeader, messageTypeHeader);

	// Sizes
	const headersLength = headers.length;
	const totalLength = 12 + headersLength + payloadBytes.length + 4; // prelude + headers + payload + trailing CRC

	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);

	view.setUint32(0, totalLength, false);
	view.setUint32(4, headersLength, false);
	view.setUint32(8, 0, false); // prelude CRC (0 — not validated in our parser)

	frame.set(headers, 12);
	frame.set(payloadBytes, 12 + headersLength);
	view.setUint32(totalLength - 4, 0, false); // message CRC (0 — not validated)

	return frame;
}

function buildStringHeader(name: string, value: string): Uint8Array {
	const encoder = new TextEncoder();
	const nameBytes = encoder.encode(name);
	const valueBytes = encoder.encode(value);

	// 1 (nameLen) + nameBytes + 1 (valueType) + 2 (valueLen) + valueBytes
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	let offset = 0;
	header[offset++] = nameBytes.length;
	header.set(nameBytes, offset);
	offset += nameBytes.length;
	header[offset++] = 7; // string value type
	header[offset++] = (valueBytes.length >> 8) & 0xff;
	header[offset++] = valueBytes.length & 0xff;
	header.set(valueBytes, offset);

	return header;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

function buildConverseStream(events: Array<{ type: string; payload: unknown }>): ReadableStream<Uint8Array> {
	const frames = concat(...events.map((e) => buildEventStreamFrame(e.type, e.payload)));
	return new ReadableStream({
		start(controller) {
			controller.enqueue(frames);
			controller.close();
		},
	});
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function simpleTextStream(): ReadableStream<Uint8Array> {
	return buildConverseStream([
		{ type: "messageStart", payload: { role: "assistant" } },
		{ type: "contentBlockStart", payload: { contentBlockIndex: 0, start: { text: "" } } },
		{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "Hello!" } } },
		{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
		{ type: "messageStop", payload: { stopReason: "end_turn" } },
		{
			type: "metadata",
			payload: {
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				metrics: { latencyMs: 100 },
			},
		},
	]);
}

function toolUseStream(): ReadableStream<Uint8Array> {
	return buildConverseStream([
		{ type: "messageStart", payload: { role: "assistant" } },
		{
			type: "contentBlockStart",
			payload: {
				contentBlockIndex: 0,
				start: { toolUse: { toolUseId: "tool-1", name: "my_tool" } },
			},
		},
		{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { toolUse: { input: '{"key":' } } } },
		{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { toolUse: { input: '"value"}' } } } },
		{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
		{ type: "messageStop", payload: { stopReason: "tool_use" } },
		{
			type: "metadata",
			payload: {
				usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
				metrics: { latencyMs: 200 },
			},
		},
	]);
}

// ---------------------------------------------------------------------------
// Collect helper
// ---------------------------------------------------------------------------

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("amazon-bedrock provider (Converse API)", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends POST to the Bedrock Runtime converse-stream endpoint with Bearer auth", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedInit = init;
			return new Response(simpleTextStream(), {
				status: 200,
				headers: { "Content-Type": "application/vnd.amazon.eventstream" },
			});
		}) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "bedrock-key", region: "us-east-1" });
		await collect(
			provider.stream({
				model: "anthropic.claude-opus-4-7",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(capturedUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-opus-4-7/converse-stream");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer bedrock-key");
	});

	test("uses correct URL for cross-region inference model IDs", async () => {
		let capturedUrl = "";

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			capturedUrl = url.toString();
			return new Response(simpleTextStream(), {
				status: 200,
				headers: { "Content-Type": "application/vnd.amazon.eventstream" },
			});
		}) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "bedrock-key", region: "eu-north-1" });
		await collect(
			provider.stream({
				model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		expect(capturedUrl).toBe(
			"https://bedrock-runtime.eu-north-1.amazonaws.com/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream",
		);
	});

	test("routes non-Anthropic models through the same Converse endpoint", async () => {
		let capturedUrl = "";

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			capturedUrl = url.toString();
			return new Response(simpleTextStream(), {
				status: 200,
				headers: { "Content-Type": "application/vnd.amazon.eventstream" },
			});
		}) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "bedrock-key", region: "us-east-1" });
		await collect(
			provider.stream({
				model: "deepseek.v3-v1:0",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(capturedUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/deepseek.v3-v1%3A0/converse-stream");
		expect(capturedUrl).not.toContain("mantle");
	});

	test("emits text events from contentBlockDelta", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(simpleTextStream(), {
					status: 200,
					headers: { "Content-Type": "application/vnd.amazon.eventstream" },
				}),
		) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "key", region: "us-east-1" });
		const events = await collect(
			provider.stream({ model: "anthropic.claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
		);

		const textEvents = events.filter((e) => e.type === "text");
		expect(textEvents).toEqual([{ type: "text", text: "Hello!" }]);
	});

	test("emits tool_call_start and tool_call_delta events", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(toolUseStream(), {
					status: 200,
					headers: { "Content-Type": "application/vnd.amazon.eventstream" },
				}),
		) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "key", region: "us-east-1" });
		const events = await collect(
			provider.stream({ model: "anthropic.claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
		);

		expect(events).toContainEqual({ type: "tool_call_start", index: 0, id: "tool-1", name: "my_tool" });
		expect(events).toContainEqual({ type: "tool_call_delta", index: 0, arguments: '{"key":' });
		expect(events).toContainEqual({ type: "tool_call_delta", index: 0, arguments: '"value"}' });
	});

	test("emits finish with reason tool_calls when stopReason is tool_use", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(toolUseStream(), {
					status: 200,
					headers: { "Content-Type": "application/vnd.amazon.eventstream" },
				}),
		) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "key", region: "us-east-1" });
		const events = await collect(
			provider.stream({ model: "anthropic.claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
		);

		const finish = events.find((e) => e.type === "finish");
		expect(finish).toEqual({ type: "finish", reason: "tool_calls" });
	});

	test("emits usage event with token counts", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(simpleTextStream(), {
					status: 200,
					headers: { "Content-Type": "application/vnd.amazon.eventstream" },
				}),
		) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "key", region: "us-east-1" });
		const events = await collect(
			provider.stream({ model: "anthropic.claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
		);

		const usage = events.find((e) => e.type === "usage");
		expect(usage).toMatchObject({ type: "usage", tokenCount: 10, outputTokens: 5, totalTokens: 15 });
	});

	test("throws ProviderError on non-OK HTTP response", async () => {
		globalThis.fetch = mock(async () => new Response("Forbidden", { status: 403 })) as typeof fetch;

		const provider = createAmazonBedrockProvider({ apiKey: "key", region: "us-east-1" });
		await expect(
			collect(provider.stream({ model: "anthropic.claude-opus-4-7", messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow(/403/);
	});
});
