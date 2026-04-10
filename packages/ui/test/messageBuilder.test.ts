import { describe, expect, test } from "bun:test";
import { appendPart, appendText } from "../src/messageBuilder";
import type { Message, MessagePart } from "../src/protocol";

describe("appendPart", () => {
	test("empty message list → creates a new assistant message with the part", () => {
		const part: MessagePart = { type: "tool_call", id: "tc1", content: "▸ read_file foo.ts" };
		const result = appendPart([], part);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ role: "assistant", parts: [part] });
	});

	test("last message is a user message → creates a new assistant message", () => {
		const prev: Message[] = [{ role: "user", text: "hello", timestamp: "2025-01-01 00:00:00" }];
		const part: MessagePart = { type: "text", content: "response" };
		const result = appendPart(prev, part);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(prev[0]);
		expect(result[1]).toEqual({ role: "assistant", parts: [part] });
	});

	test("last message is an assistant message → appends part to its parts array", () => {
		const existingPart: MessagePart = { type: "text", content: "hello" };
		const prev: Message[] = [{ role: "assistant", parts: [existingPart] }];
		const newPart: MessagePart = { type: "tool_call", id: "tc1", content: "▸ bash ls" };
		const result = appendPart(prev, newPart);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ role: "assistant", parts: [existingPart, newPart] });
	});

	test("returns a new array (immutability check)", () => {
		const existingPart: MessagePart = { type: "text", content: "hello" };
		const prev: Message[] = [{ role: "assistant", parts: [existingPart] }];
		const newPart: MessagePart = { type: "tool_call", id: "tc1", content: "▸ bash ls" };
		const result = appendPart(prev, newPart);
		expect(result).not.toBe(prev);
		// Original array is unchanged
		expect(prev).toHaveLength(1);
		if (prev[0].role === "assistant") {
			expect(prev[0].parts).toHaveLength(1);
		}
	});
});

describe("appendText", () => {
	test("empty message list → creates assistant message with text part", () => {
		const result = appendText([], "hello");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ role: "assistant", parts: [{ type: "text", content: "hello" }] });
	});

	test("last message is user → creates new assistant message with text part", () => {
		const prev: Message[] = [{ role: "user", text: "question", timestamp: "2025-01-01 00:00:00" }];
		const result = appendText(prev, "answer");
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(prev[0]);
		expect(result[1]).toEqual({ role: "assistant", parts: [{ type: "text", content: "answer" }] });
	});

	test("last message is assistant, last part is text → concatenates text", () => {
		const prev: Message[] = [{ role: "assistant", parts: [{ type: "text", content: "Hello " }] }];
		const result = appendText(prev, "world");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ role: "assistant", parts: [{ type: "text", content: "Hello world" }] });
	});

	test("last message is assistant, last part is tool_call → creates new text part", () => {
		const prev: Message[] = [{ role: "assistant", parts: [{ type: "tool_call", id: "tc1", content: "▸ bash ls" }] }];
		const result = appendText(prev, "Found files");
		expect(result).toHaveLength(1);
		if (result[0].role === "assistant") {
			expect(result[0].parts).toHaveLength(2);
			expect(result[0].parts[0]).toEqual({ type: "tool_call", id: "tc1", content: "▸ bash ls" });
			expect(result[0].parts[1]).toEqual({ type: "text", content: "Found files" });
		}
	});

	test("last message is assistant with empty parts array → creates new assistant message with text part", () => {
		const prev: Message[] = [{ role: "assistant", parts: [] }];
		const result = appendText(prev, "text");
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ role: "assistant", parts: [] });
		expect(result[1]).toEqual({ role: "assistant", parts: [{ type: "text", content: "text" }] });
	});
});
