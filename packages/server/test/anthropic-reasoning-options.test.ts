import { describe, expect, test } from "bun:test";
import { getReasoningCapabilities } from "../src/provider/reasoning-capabilities";

async function getModule() {
	return import("../src/provider/anthropic-compatible");
}

describe("anthropic reasoning options", () => {
	test("returns conservative default thinking controls for anthropic-thinking capabilities", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "claude-sonnet-4-6",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities)).toEqual({
			thinking: {
				type: "enabled",
				budget_tokens: 1024,
				display: "omitted",
			},
		});
	});

	test("derives anthropic thinking controls from passed defaults", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "claude-sonnet-4-6",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, { budgetTokens: 2048, display: "summarized" })).toEqual({
			thinking: {
				type: "enabled",
				budget_tokens: 2048,
				display: "summarized",
			},
		});
	});

	test("returns no reasoning controls for non-anthropic capability families", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "qwen3.6-plus",
			apiFamily: "openai-chat-completions",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities)).toBeUndefined();
	});
});
