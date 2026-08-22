import { describe, expect, test } from "bun:test";

async function getCapabilities(args: {
	providerId: "openrouter" | "opencode-go" | "opencode-zen";
	modelId: string;
	apiFamily: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
}) {
	const module = await import("../src/provider/reasoning-capabilities");
	return module.getReasoningCapabilities(args);
}

describe("reasoning capabilities", () => {
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

	test("unknown chat-completions model resolves family = none with replay disabled", async () => {
		const capabilities = await getCapabilities({
			providerId: "openrouter",
			modelId: "openrouter/free",
			apiFamily: "openai-chat-completions",
		});

		expect(capabilities.family).toBe("none");
		expect(capabilities.supportsReplay).toBe(false);
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

describe("chat reasoning effort", () => {
	async function getEffort(providerId: "openrouter" | "opencode-go" | "opencode-zen" | "deepseek", modelId: string) {
		const module = await import("../src/provider/reasoning-capabilities");
		return module.getChatReasoningEffort(providerId, modelId);
	}

	test("deepseek models pin reasoning effort to high", async () => {
		expect(await getEffort("opencode-go", "deepseek-v4-pro")).toBe("high");
		expect(await getEffort("opencode-go", "deepseek-v4-flash")).toBe("high");
		expect(await getEffort("deepseek", "deepseek-chat")).toBe("high");
	});

	test("openrouter deepseek models pin reasoning effort to high", async () => {
		expect(await getEffort("openrouter", "openrouter/deepseek-r1")).toBe("high");
		expect(await getEffort("openrouter", "deepseek/deepseek-chat")).toBe("high");
	});

	test("non-deepseek models have no chat reasoning effort override", async () => {
		expect(await getEffort("opencode-go", "kimi-k2.6")).toBeUndefined();
		expect(await getEffort("opencode-zen", "qwen3.6-plus")).toBeUndefined();
		expect(await getEffort("openrouter", "openrouter/free")).toBeUndefined();
	});
});
