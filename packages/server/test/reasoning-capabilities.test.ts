import { describe, expect, test } from "bun:test";

async function getCapabilities(args: {
	providerId: "github-copilot" | "openrouter" | "opencode-go" | "opencode-zen";
	modelId: string;
	apiFamily: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
}) {
	const module = await import("../src/provider/reasoning-capabilities");
	return module.getReasoningCapabilities(args);
}

describe("reasoning capabilities", () => {
	test("responses-family model resolves family = openai-responses with replay enabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "gpt-5.2",
			apiFamily: "openai-responses",
		});

		expect(capabilities.family).toBe("openai-responses");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBeUndefined();
	});

	test("interleaved chat model resolves family = openai-chat-interleaved and field = reasoning_content", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-go",
			modelId: "deepseek-v4-flash",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning_content");
	});

	test("openrouter deepseek chat model resolves reasoning field = reasoning", async () => {
		// OpenRouter normalizes deepseek reasoning to "reasoning" field, not "reasoning_content".
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/deepseek-r1",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning");
	});

	test("kimi chat model resolves interleaved reasoning field = reasoning", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-go",
			modelId: "kimi-k2.6",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning");
	});

	test("qwen chat model resolves interleaved reasoning field = reasoning_details", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-zen",
			modelId: "qwen3.6-plus",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning_details");
	});

	test("anthropic model resolves family = anthropic-thinking with replay disabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});

		expect(capabilities.family).toBe("anthropic-thinking");
		expect(capabilities.supportsReplay).toBe(false);
		expect(capabilities.assistantField).toBeUndefined();
	});

	test("unknown chat-completions model resolves family = none with replay disabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/free",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("none");
		expect(capabilities.supportsReplay).toBe(false);
		expect(capabilities.assistantField).toBeUndefined();
	});

	test("copilot o-series chat model resolves reasoning field = reasoning", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "o4-mini",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning");
	});

	test("copilot o1 chat model resolves reasoning field = reasoning", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "o1",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning");
	});

	test("copilot gpt-4o chat model resolves family = none", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "gpt-4o",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("none");
		expect(capabilities.supportsReplay).toBe(false);
		expect(capabilities.assistantField).toBeUndefined();
	});

	test("gemini chat model resolves reasoning field = reasoning_text", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "gemini-2.5-pro",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning_text");
	});

	test("openrouter-proxied gemini resolves reasoning field = reasoning", async () => {
		// OpenRouter normalizes gemini reasoning to the "reasoning" field.
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/gemini-2.5-pro",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
		expect(capabilities.assistantField).toBe("reasoning");
	});
});
