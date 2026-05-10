import { describe, expect, test } from "bun:test";

describe("provider descriptor registry", () => {
	test("lists provider descriptors for runtime and auth providers", async () => {
		const registry = await import("../src/provider/registry");

		expect(registry.listRuntimeProviders().map((provider) => provider.id)).toEqual([
			"github-copilot",
			"openrouter",
			"opencode-go",
			"opencode-zen",
			"amazon-bedrock",
			"deepseek",
		]);
		expect(registry.listAuthProviders().map((provider) => provider.id)).toEqual([
			"github-copilot",
			"openrouter",
			"opencode-go",
			"opencode-zen",
			"amazon-bedrock",
			"deepseek",
		]);
		expect(registry.getProviderDescriptor("github-copilot")?.defaultModel).toBe("gpt-5-mini");
		expect(registry.getProviderDescriptor("openrouter")?.defaultModel).toBe("openrouter/free");
		expect(registry.getProviderDescriptor("opencode-go")?.defaultModel).toBe("deepseek-v4-flash");
		expect(registry.getProviderDescriptor("opencode-zen")?.defaultModel).toBe("minimax-m2.5-free");
		expect(registry.getProviderDescriptor("amazon-bedrock")?.defaultModel).toBe("anthropic.claude-opus-4-7");
		expect(registry.getProviderDescriptor("deepseek")?.defaultModel).toBe("deepseek-v4-flash");
	});

	test("exposes provider-specific API-family resolution through descriptors", async () => {
		const registry = await import("../src/provider/registry");

		expect(registry.getProviderDescriptor("github-copilot")?.getApiFamily("claude-haiku-4.5")).toBe("anthropic-messages");
		expect(registry.getProviderDescriptor("github-copilot")?.getApiFamily("gpt-5.2")).toBe("openai-responses");
		expect(registry.getProviderDescriptor("openrouter")?.getApiFamily("openrouter/free")).toBe("openai-chat-completions");
		expect(registry.getProviderDescriptor("opencode-go")?.getApiFamily("kimi-k2.6")).toBe("openai-chat-completions");
		expect(registry.getProviderDescriptor("opencode-go")?.getApiFamily("minimax-m2.7")).toBe("anthropic-messages");
		expect(registry.getProviderDescriptor("opencode-zen")?.getApiFamily("claude-sonnet-4-6")).toBe("anthropic-messages");
		expect(registry.getProviderDescriptor("opencode-zen")?.getApiFamily("gpt-5.4")).toBe("openai-responses");
		expect(registry.getProviderDescriptor("opencode-zen")?.getApiFamily("qwen3.6-plus")).toBe("openai-chat-completions");
		expect(registry.getProviderDescriptor("amazon-bedrock")?.getApiFamily("anthropic.claude-opus-4-7")).toBe(
			"anthropic-messages",
		);
		expect(registry.getProviderDescriptor("amazon-bedrock")?.getApiFamily("us.amazon.nova-pro-v1:0")).toBe(
			"openai-chat-completions",
		);
		expect(registry.getProviderDescriptor("deepseek")?.getApiFamily("deepseek-v4-flash")).toBe("openai-chat-completions");
		expect(registry.getProviderDescriptor("deepseek")?.getApiFamily("deepseek-v4-pro")).toBe("openai-chat-completions");
	});
});
