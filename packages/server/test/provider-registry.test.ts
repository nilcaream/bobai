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
		expect(SUPPORTED_AUTH_PROVIDERS).toEqual(["github-copilot", "openrouter", "opencode-go"]);
		expect(SUPPORTED_RUNTIME_PROVIDERS).toEqual(["github-copilot", "openrouter", "opencode-go"]);
	});

	test("returns the default model for github-copilot", () => {
		expect(getDefaultModelForProvider("github-copilot")).toBe("gpt-5-mini");
	});

	test("recognizes supported runtime provider ids", () => {
		expect(isSupportedProvider("github-copilot")).toBe(true);
		expect(isSupportedProvider("openrouter")).toBe(true);
		expect(isSupportedProvider("opencode-go")).toBe(true);
		expect(isSupportedProvider("anything-else")).toBe(false);
	});

	test("recognizes supported auth provider ids", () => {
		expect(isSupportedAuthProvider("github-copilot")).toBe(true);
		expect(isSupportedAuthProvider("openrouter")).toBe(true);
		expect(isSupportedAuthProvider("opencode-go")).toBe(true);
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
		expect(getDefaultModelForProvider("opencode-go")).toBe("kimi-k2.6");
	});

	test("exposes provider descriptor metadata through the registry", () => {
		expect(getProviderDescriptor("github-copilot")?.defaultModel).toBe("gpt-5-mini");
		expect(getProviderDescriptor("github-copilot")?.getApiFamily("claude-haiku-4.5")).toBe("anthropic-messages");
		expect(getProviderDescriptor("openrouter")?.defaultModel).toBe("openrouter/free");
		expect(getProviderDescriptor("openrouter")?.getApiFamily("openrouter/free")).toBe("openai-chat-completions");
		expect(getProviderDescriptor("opencode-go")?.defaultModel).toBe("kimi-k2.6");
		expect(getProviderDescriptor("opencode-go")?.getApiFamily("kimi-k2.6")).toBe("openai-chat-completions");
	});
});
