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
	});

	test("interleaved chat model resolves family = openai-chat-interleaved", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-go",
			modelId: "deepseek-v4-flash",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("openrouter deepseek chat model resolves to interleaved family", async () => {
		// OpenRouter normalizes deepseek reasoning — field is auto-detected from stream.
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/deepseek-r1",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("kimi chat model resolves to interleaved family", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-go",
			modelId: "kimi-k2.6",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("qwen chat model resolves to interleaved family", async () => {
		const capabilities = await getCapabilities({
			providerId: "opencode-zen",
			modelId: "qwen3.6-plus",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("anthropic model resolves family = anthropic-thinking with replay disabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "claude-sonnet-4.5",
			apiFamily: "anthropic-messages",
		});

		expect(capabilities.family).toBe("anthropic-thinking");
		expect(capabilities.supportsReplay).toBe(false);
	});

	test("unknown chat-completions model resolves family = none with replay disabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/free",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("none");
		expect(capabilities.supportsReplay).toBe(false);
	});

	test("copilot o-series chat model resolves to interleaved family", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "o4-mini",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("copilot o1 chat model resolves to interleaved family", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "o1",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("copilot gpt-4o chat model resolves family = none", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "gpt-4o",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("none");
		expect(capabilities.supportsReplay).toBe(false);
	});

	test("gemini chat model resolves to interleaved family", async () => {
		const capabilities = await getCapabilities({
			providerId: "github-copilot",
			modelId: "gemini-2.5-pro",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});

	test("openrouter-proxied gemini resolves to interleaved family", async () => {
		// OpenRouter normalizes gemini reasoning — field is auto-detected from stream.
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/gemini-2.5-pro",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("openai-chat-interleaved");
		expect(capabilities.supportsReplay).toBe(true);
	});
});
