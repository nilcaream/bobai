import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROVIDER_ID,
	getDefaultModelForProvider,
	isSupportedAuthProvider,
	isSupportedProvider,
	SUPPORTED_AUTH_PROVIDERS,
	SUPPORTED_RUNTIME_PROVIDERS,
} from "../src/provider/providers";
import { getProviderDescriptor } from "../src/provider/registry";

describe("provider registry", () => {
	test("exposes github-copilot as the default runtime provider", () => {
		expect(DEFAULT_PROVIDER_ID).toBe("github-copilot");
	});

	test("lists supported auth providers separately from runtime providers", () => {
		expect(SUPPORTED_AUTH_PROVIDERS).toEqual(["github-copilot", "openrouter", "opencode-go", "opencode-zen", "amazon-bedrock"]);
		expect(SUPPORTED_RUNTIME_PROVIDERS).toEqual(["github-copilot", "openrouter", "opencode-go", "opencode-zen", "amazon-bedrock"]);
	});

	test("returns the default model for github-copilot", () => {
		expect(getDefaultModelForProvider("github-copilot")).toBe("gpt-5-mini");
	});

	test("recognizes supported runtime provider ids", () => {
		expect(isSupportedProvider("github-copilot")).toBe(true);
		expect(isSupportedProvider("openrouter")).toBe(true);
		expect(isSupportedProvider("opencode-go")).toBe(true);
		expect(isSupportedProvider("opencode-zen")).toBe(true);
		expect(isSupportedProvider("anything-else")).toBe(false);
	});

	test("recognizes supported auth provider ids", () => {
		expect(isSupportedAuthProvider("github-copilot")).toBe(true);
		expect(isSupportedAuthProvider("openrouter")).toBe(true);
		expect(isSupportedAuthProvider("opencode-go")).toBe(true);
		expect(isSupportedAuthProvider("opencode-zen")).toBe(true);
		expect(isSupportedAuthProvider("anything-else")).toBe(false);
	});

	test("recognizes openrouter as a runtime provider", () => {
		expect(isSupportedAuthProvider("openrouter")).toBe(true);
		expect(isSupportedProvider("openrouter")).toBe(true);
		expect(getDefaultModelForProvider("openrouter")).toBe("openrouter/free");
	});

	test("recognizes opencode-go as a runtime provider", () => {
		expect(isSupportedAuthProvider("opencode-go")).toBe(true);
		expect(isSupportedProvider("opencode-go")).toBe(true);
		expect(getDefaultModelForProvider("opencode-go")).toBe("deepseek-v4-flash");
	});

	test("recognizes opencode-zen as a runtime provider", () => {
		expect(isSupportedAuthProvider("opencode-zen")).toBe(true);
		expect(isSupportedProvider("opencode-zen")).toBe(true);
		expect(getDefaultModelForProvider("opencode-zen")).toBe("minimax-m2.5-free");
	});

	test("exposes provider descriptor metadata through the registry", () => {
		expect(getProviderDescriptor("github-copilot")?.defaultModel).toBe("gpt-5-mini");
		expect(getProviderDescriptor("github-copilot")?.getApiFamily("claude-haiku-4.5")).toBe("anthropic-messages");
		expect(getProviderDescriptor("openrouter")?.defaultModel).toBe("openrouter/free");
		expect(getProviderDescriptor("openrouter")?.getApiFamily("openrouter/free")).toBe("openai-chat-completions");
		expect(getProviderDescriptor("opencode-go")?.defaultModel).toBe("deepseek-v4-flash");
		expect(getProviderDescriptor("opencode-go")?.getApiFamily("deepseek-v4-flash")).toBe("openai-chat-completions");
		expect(getProviderDescriptor("opencode-zen")?.defaultModel).toBe("minimax-m2.5-free");
		expect(getProviderDescriptor("opencode-zen")?.getApiFamily("minimax-m2.5-free")).toBe("openai-chat-completions");
		expect(getProviderDescriptor("opencode-zen")?.getApiFamily("gpt-5.4")).toBe("openai-responses");
		expect(getProviderDescriptor("opencode-zen")?.getApiFamily("qwen3.6-plus")).toBe("openai-chat-completions");
	});
});
