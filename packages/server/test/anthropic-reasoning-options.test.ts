import { describe, expect, test } from "bun:test";
import { getReasoningCapabilities } from "../src/provider/reasoning-capabilities";

async function getModule() {
	return import("../src/provider/anthropic-compatible");
}

describe("anthropic reasoning options", () => {
	test("claude models use output_config.effort instead of a thinking budget", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "claude-sonnet-4-6",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, undefined, "claude-sonnet-4-6")).toEqual({
			output_config: { effort: "high" },
		});
	});

	test("budget-based models use a 16384-token thinking budget by default", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-go",
			modelId: "minimax-m2.7",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, undefined, "minimax-m2.7")).toEqual({
			thinking: {
				type: "enabled",
				budget_tokens: 16384,
				display: "summarized",
			},
		});
	});

	test("derives budget-based thinking controls from passed defaults", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-go",
			modelId: "minimax-m2.7",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, { budgetTokens: 2048, display: "summarized" }, "minimax-m2.7")).toEqual({
			thinking: {
				type: "enabled",
				budget_tokens: 2048,
				display: "summarized",
			},
		});
	});

	test("derives claude effort from passed defaults", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "claude-opus-4-7",
			apiFamily: "anthropic-messages",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, { effort: "medium" }, "claude-opus-4-7")).toEqual({
			output_config: { effort: "medium" },
		});
	});

	test("returns no reasoning controls for non-anthropic capability families", async () => {
		const capabilities = getReasoningCapabilities({
			providerId: "opencode-zen",
			modelId: "qwen3.6-plus",
			apiFamily: "openai-chat-completions",
		});
		const { getAnthropicReasoningOptions } = await getModule();

		expect(getAnthropicReasoningOptions(capabilities, undefined, "qwen3.6-plus")).toBeUndefined();
	});
});
