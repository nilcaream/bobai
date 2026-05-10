import { describe, expect, test } from "bun:test";
import {
	getApiFamilyForModel,
	getDefaultSessionBackend,
	validateModelSwitch,
	validateProviderSwitch,
} from "../src/provider/backend-policy";

describe("backend policy", () => {
	test("resolves github-copilot default backend", () => {
		expect(getDefaultSessionBackend("github-copilot")).toEqual({
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
	});

	test("maps copilot models to API families", () => {
		expect(getApiFamilyForModel("github-copilot", "claude-haiku-4.5")).toBe("anthropic-messages");
		expect(getApiFamilyForModel("github-copilot", "gpt-5.2")).toBe("openai-responses");
		expect(getApiFamilyForModel("github-copilot", "gpt-5-mini")).toBe("openai-chat-completions");
	});

	test("maps opencode-go chat-completions models to the chat completions family", () => {
		expect(getApiFamilyForModel("opencode-go", "kimi-k2.6")).toBe("openai-chat-completions");
	});

	test("maps opencode-go minimax models to the anthropic messages family", () => {
		expect(getApiFamilyForModel("opencode-go", "minimax-m2.7")).toBe("anthropic-messages");
	});

	test("maps opencode-zen claude models to anthropic messages, gpt models to responses, and qwen models to chat completions", () => {
		expect(getApiFamilyForModel("opencode-zen", "claude-sonnet-4-6")).toBe("anthropic-messages");
		expect(getApiFamilyForModel("opencode-zen", "gpt-5.4")).toBe("openai-responses");
		expect(getApiFamilyForModel("opencode-zen", "qwen3.6-plus")).toBe("openai-chat-completions");
	});

	test("allows provider switch on empty session when runtime is supported", () => {
		const result = validateProviderSwitch({
			hasMessages: false,
			current: getDefaultSessionBackend("github-copilot"),
			nextProvider: "github-copilot",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.next).toEqual(getDefaultSessionBackend("github-copilot"));
		}
	});

	test("rejects provider switch on non-empty session", () => {
		const result = validateProviderSwitch({
			hasMessages: true,
			current: getDefaultSessionBackend("github-copilot"),
			nextProvider: "github-copilot",
		});
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/not yet supported/i) });
	});

	test("rejects cross-family model switch on non-empty session", () => {
		const result = validateModelSwitch({
			hasMessages: true,
			current: {
				provider: "github-copilot",
				model: "claude-haiku-4.5",
				apiFamily: "anthropic-messages",
			},
			nextModel: "gpt-5.2",
		});
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
	});

	test("maps amazon-bedrock anthropic models to anthropic-messages backend", () => {
		expect(getApiFamilyForModel("amazon-bedrock", "anthropic.claude-opus-4-7")).toBe("anthropic-messages");
	});

	test("maps amazon-bedrock non-anthropic models to openai-chat-completions backend", () => {
		expect(getApiFamilyForModel("amazon-bedrock", "deepseek.v3-v1:0")).toBe("openai-chat-completions");
	});

	test("maps deepseek models to openai-chat-completions backend", () => {
		expect(getApiFamilyForModel("deepseek", "deepseek-v4-flash")).toBe("openai-chat-completions");
		expect(getApiFamilyForModel("deepseek", "deepseek-v4-pro")).toBe("openai-chat-completions");
	});
});
