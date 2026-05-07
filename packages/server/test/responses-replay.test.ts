import { describe, expect, test } from "bun:test";
import { getReasoningCapabilities } from "../src/provider/reasoning-capabilities";
import { convertMessagesToResponses } from "../src/provider/responses-convert";

describe("Responses reasoning replay", () => {
	test("replays prior assistant reasoning items for openai-responses when replay is supported", () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "gpt-5.4",
			apiFamily: "openai-responses",
		});
		expect(capabilities.family).toBe("openai-responses");
		expect(capabilities.supportsReplay).toBe(true);

		const input = convertMessagesToResponses(
			[
				{ role: "system", content: "Be helpful." },
				{ role: "user", content: "Use the tool." },
				{
					role: "assistant",
					content: "Let me check.",
					reasoning: [{ kind: "responses-item", id: "rs_1", summary: "Need file context", encryptedContent: "enc_abc" }],
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
						},
					],
				},
				{ role: "tool", content: "file contents", tool_call_id: "call_1" },
			],
			capabilities,
		);

		expect(input).toEqual([
			{ role: "developer", content: "Be helpful." },
			{ role: "user", content: [{ type: "input_text", text: "Use the tool." }] },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "Need file context" }],
				encrypted_content: "enc_abc",
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Let me check." }],
				status: "completed",
			},
			{ type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts"}' },
			{ type: "function_call_output", call_id: "call_1", output: "file contents" },
		]);
	});

	test("does not replay non-Responses reasoning structures into Responses input", () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "gpt-5.4",
			apiFamily: "openai-responses",
		});

		const input = convertMessagesToResponses(
			[
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: "hi",
					reasoning: [
						{ kind: "text-summary", text: "short summary" },
						{ kind: "interleaved-chat", field: "reasoning_content", text: "hidden" },
					],
				},
			],
			capabilities,
		);

		expect(input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi" }],
				status: "completed",
			},
		]);
	});
});
