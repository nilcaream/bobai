import { describe, expect, test } from "bun:test";

describe("provider descriptor registry", () => {
	test("lists provider descriptors for runtime and auth providers", async () => {
		const registry = await import("../src/provider/registry");

		expect(registry.listRuntimeProviders().map((provider) => provider.id)).toEqual(["github-copilot", "openrouter"]);
		expect(registry.listAuthProviders().map((provider) => provider.id)).toEqual(["github-copilot", "openrouter"]);
		expect(registry.getProviderDescriptor("github-copilot")?.defaultModel).toBe("gpt-5-mini");
		expect(registry.getProviderDescriptor("openrouter")?.defaultModel).toBe("openrouter/free");
	});

	test("exposes provider-specific API-family resolution through descriptors", async () => {
		const registry = await import("../src/provider/registry");

		expect(registry.getProviderDescriptor("github-copilot")?.getApiFamily("claude-haiku-4.5")).toBe("anthropic-messages");
		expect(registry.getProviderDescriptor("github-copilot")?.getApiFamily("gpt-5.2")).toBe("openai-responses");
		expect(registry.getProviderDescriptor("openrouter")?.getApiFamily("openrouter/free")).toBe("openai-chat-completions");
	});
});
