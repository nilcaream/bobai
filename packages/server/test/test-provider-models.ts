import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

export function createProviderModelsTempDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-provider-models-shared-"));
	writeUnifiedModelsConfig(tmpDir, {
		"github-copilot": createCopilotModels([
			{ id: "claude-haiku-4.5", contextWindow: 128000, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
			{ id: "gpt-4o", contextWindow: 64000, maxOutput: 4096 },
			{ id: "gpt-5-mini", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 0 },
			{ id: "gpt-5.2", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 1 },
			{ id: "gpt-5.4", contextWindow: 272000, maxOutput: 64000, premiumRequestMultiplier: 1 },
			{ id: "gemini-3-flash-preview", contextWindow: 1000000, maxOutput: 64000 },
		]),
		openrouter: [
			{
				id: "openrouter/free",
				name: "OpenRouter Free Router",
				contextWindow: 200000,
				maxOutput: 16384,
				inputPrice: 0,
				outputPrice: 0,
			},
			{
				id: "anthropic/claude-haiku-4.5",
				name: "Anthropic Claude Haiku 4.5",
				contextWindow: 128000,
				maxOutput: 64000,
				inputPrice: 0.5,
				outputPrice: 5.12,
			},
		],
		"opencode-go": [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.27,
				outputPrice: 1.1,
			},
			{
				id: "kimi-k2.6",
				name: "Kimi K2.6",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.6,
				outputPrice: 2.4,
			},
			{
				id: "minimax-m2.7",
				name: "MiniMax M2.7",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.8,
				outputPrice: 3,
			},
		],
		"opencode-zen": [
			{
				id: "minimax-m2.5-free",
				name: "MiniMax M2.5 Free",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0,
				outputPrice: 0,
			},
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				contextWindow: 200000,
				maxOutput: 64000,
				inputPrice: 3,
				outputPrice: 15,
			},
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				contextWindow: 272000,
				maxOutput: 64000,
				inputPrice: 1,
				outputPrice: 4,
			},
			{
				id: "qwen3.6-plus",
				name: "Qwen3.6 Plus",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.3,
				outputPrice: 1.2,
			},
		],
		"amazon-bedrock": [
			{
				id: "anthropic.claude-opus-4-7",
				name: "Claude Opus 4.7",
				contextWindow: 1000000,
				maxOutput: 64000,
				inputPrice: 15,
				outputPrice: 75,
			},
			{
				id: "anthropic.claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				contextWindow: 1000000,
				maxOutput: 64000,
				inputPrice: 0.8,
				outputPrice: 4,
			},
			{
				id: "deepseek.v3-v1:0",
				name: "DeepSeek V3",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.27,
				outputPrice: 1.1,
			},
			{
				id: "mistral.devstral-2-123b",
				name: "Devstral 2 123B",
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		],
		deepseek: [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				contextWindow: 1000000,
				maxOutput: 384000,
				inputPrice: 0.14,
				outputPrice: 0.28,
				cacheReadPrice: 0.028,
			},
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				contextWindow: 1000000,
				maxOutput: 384000,
				inputPrice: 1.74,
				outputPrice: 3.48,
			},
		],
	});
	return tmpDir;
}
