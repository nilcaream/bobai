import { describe, expect, test } from "bun:test";
import { getOpenCodeGoApiFamily, getOpenCodeZenApiFamily } from "../src/provider/opencode-routing";

describe("opencode-go endpoint routing", () => {
	test("routes Responses-API models to openai-responses", () => {
		for (const model of ["grok-4.5", "gpt-5.6-luna", "muse-spark-1.2-contributor"]) {
			expect(getOpenCodeGoApiFamily(model)).toBe("openai-responses");
		}
	});

	test("routes MiniMax models to anthropic-messages", () => {
		for (const model of ["minimax-m2.5", "minimax-m2.7", "minimax-m3"]) {
			expect(getOpenCodeGoApiFamily(model)).toBe("anthropic-messages");
		}
	});

	test("routes everything else to chat completions", () => {
		for (const model of ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3", "qwen3.8-max", "glm-5.3", "mimo-v2.5-pro"]) {
			expect(getOpenCodeGoApiFamily(model)).toBe("openai-chat-completions");
		}
	});
});

describe("opencode-zen endpoint routing", () => {
	test("routes GPT and Responses-only Grok models to openai-responses", () => {
		for (const model of ["gpt-5.4", "gpt-5.6-luna", "grok-4.5", "grok-build-0.1"]) {
			expect(getOpenCodeZenApiFamily(model)).toBe("openai-responses");
		}
	});

	test("routes Claude models to anthropic-messages", () => {
		for (const model of ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"]) {
			expect(getOpenCodeZenApiFamily(model)).toBe("anthropic-messages");
		}
	});

	test("routes everything else to chat completions", () => {
		for (const model of ["deepseek-v4-flash", "glm-5.2", "kimi-k3", "minimax-m3", "qwen3-coder", "grok-code", "grok-4.6"]) {
			expect(getOpenCodeZenApiFamily(model)).toBe("openai-chat-completions");
		}
	});
});
