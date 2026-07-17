import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSortedProviderModelList,
	formatProviderModelDisplay,
	getProviderModelConfig,
	loadProviderModelsConfig,
	providerModelsConfigExists,
} from "../src/provider/models";

function withTempDir(run: (tmpDir: string) => void) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-provider-models-"));
	try {
		run(tmpDir);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function writeModelsConfig(tmpDir: string) {
	fs.writeFileSync(
		path.join(tmpDir, "models.json"),
		JSON.stringify(
			{
				version: 1,
				generatedAt: "2026-05-05T00:00:00.000Z",
				providers: {
					openrouter: [
						{
							id: "anthropic/claude-haiku-4.5",
							name: "Anthropic Claude Haiku 4.5",
							contextWindow: 128000,
							maxOutput: 64000,
							inputPrice: 0.5,
							outputPrice: 5.12,
							cacheReadPrice: 0.05,
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
							id: "gpt-5.4",
							name: "GPT-5.4",
							contextWindow: 272000,
							maxOutput: 64000,
							inputPrice: 1,
							outputPrice: 4,
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
							id: "deepseek.v3-v1:0",
							name: "DeepSeek V3",
							contextWindow: 131072,
							maxOutput: 16384,
							inputPrice: 0.27,
							outputPrice: 1.1,
						},
					],
				},
			},
			null,
			2,
		),
	);
}

describe("provider model facade", () => {
	test("checks config existence through the provider facade", () => {
		withTempDir((tmpDir) => {
			expect(providerModelsConfigExists("openrouter", tmpDir)).toBe(false);
			writeModelsConfig(tmpDir);
			expect(providerModelsConfigExists("openrouter", tmpDir)).toBe(true);
		});
	});

	test("loads provider model configs through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const models = loadProviderModelsConfig("openrouter", tmpDir);
			expect(models.map((model) => model.id)).toContain("anthropic/claude-haiku-4.5");
			expect(getProviderModelConfig("openrouter", "anthropic/claude-haiku-4.5", tmpDir)?.contextWindow).toBe(128000);
		});
	});

	test("formats model display through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			expect(formatProviderModelDisplay("openrouter", "anthropic/claude-haiku-4.5", 12800, tmpDir)).toBe(
				"openrouter | anthropic/claude-haiku-4.5 [$0.50 $5.12] | $0.00 | 12800 / 128000 | 10%",
			);
		});
	});

	test("builds the same sorted model list shape used by UI commands", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const list = buildSortedProviderModelList("openrouter", tmpDir);
			expect(list.find((model) => model.id === "anthropic/claude-haiku-4.5")).toEqual({
				id: "anthropic/claude-haiku-4.5",
				cost: "[$0.50 $5.12]",
				contextWindow: 128000,
			});
		});
	});

	test("loads unified openrouter model metadata through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const models = loadProviderModelsConfig("openrouter", tmpDir);
			expect(models.find((model) => model.id === "anthropic/claude-haiku-4.5")).toMatchObject({
				contextWindow: 128000,
				maxOutput: 64000,
				inputPrice: 0.5,
				outputPrice: 5.12,
			});
			expect(buildSortedProviderModelList("openrouter", tmpDir)).toContainEqual({
				id: "anthropic/claude-haiku-4.5",
				cost: "[$0.50 $5.12]",
				contextWindow: 128000,
			});
			expect(formatProviderModelDisplay("openrouter", "anthropic/claude-haiku-4.5", 12800, tmpDir)).toBe(
				"openrouter | anthropic/claude-haiku-4.5 [$0.50 $5.12] | $0.00 | 12800 / 128000 | 10%",
			);
		});
	});

	test("loads unified opencode-go model metadata through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const models = loadProviderModelsConfig("opencode-go", tmpDir);
			expect(models.find((model) => model.id === "deepseek-v4-flash")).toMatchObject({
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0.27,
				outputPrice: 1.1,
			});
			expect(buildSortedProviderModelList("opencode-go", tmpDir)).toContainEqual({
				id: "deepseek-v4-flash",
				cost: "[$0.27 $1.10]",
				contextWindow: 131072,
			});
			expect(formatProviderModelDisplay("opencode-go", "deepseek-v4-flash", 12800, tmpDir)).toBe(
				"opencode-go | deepseek-v4-flash [$0.27 $1.10] | $0.00 | 12800 / 131072 | 10%",
			);
		});
	});

	test("loads unified opencode-zen model metadata through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const models = loadProviderModelsConfig("opencode-zen", tmpDir);
			expect(models.find((model) => model.id === "minimax-m2.5-free")).toMatchObject({
				contextWindow: 131072,
				maxOutput: 16384,
				inputPrice: 0,
				outputPrice: 0,
			});
			expect(models.find((model) => model.id === "gpt-5.4")).toMatchObject({
				contextWindow: 272000,
				maxOutput: 64000,
				inputPrice: 1,
				outputPrice: 4,
			});
			expect(buildSortedProviderModelList("opencode-zen", tmpDir)).toContainEqual({
				id: "minimax-m2.5-free",
				cost: "[$0.00 $0.00]",
				contextWindow: 131072,
			});
			expect(buildSortedProviderModelList("opencode-zen", tmpDir)).toContainEqual({
				id: "gpt-5.4",
				cost: "[$1.00 $4.00]",
				contextWindow: 272000,
			});
			expect(formatProviderModelDisplay("opencode-zen", "minimax-m2.5-free", 12800, tmpDir)).toBe(
				"opencode-zen | minimax-m2.5-free [$0.00 $0.00] | $0.00 | 12800 / 131072 | 10%",
			);
			expect(formatProviderModelDisplay("opencode-zen", "gpt-5.4", 12800, tmpDir)).toBe(
				"opencode-zen | gpt-5.4 [$1.00 $4.00] | $0.00 | 12800 / 272000 | 5%",
			);
		});
	});

	test("throws a clear error for unsupported providers", () => {
		withTempDir((tmpDir) => {
			expect(() => loadProviderModelsConfig("not-real" as never, tmpDir)).toThrow(/Unsupported provider/);
		});
	});

	test("loads unified amazon-bedrock model metadata through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeModelsConfig(tmpDir);
			const models = loadProviderModelsConfig("amazon-bedrock", tmpDir);
			expect(models.length).toBeGreaterThan(0);
			expect(models.find((model) => model.id === "anthropic.claude-opus-4-7")).toMatchObject({
				contextWindow: 1000000,
				maxOutput: 64000,
				inputPrice: 15,
				outputPrice: 75,
			});
			expect(models.find((model) => model.id.startsWith("anthropic."))).toBeDefined();
			expect(models.find((model) => !model.id.startsWith("anthropic."))).toBeDefined();
			expect(buildSortedProviderModelList("amazon-bedrock", tmpDir)).toContainEqual({
				id: "anthropic.claude-opus-4-7",
				cost: "[$15.00 $75.00]",
				contextWindow: 1000000,
			});
			expect(formatProviderModelDisplay("amazon-bedrock", "anthropic.claude-opus-4-7", 12800, tmpDir)).toBe(
				"amazon-bedrock | anthropic.claude-opus-4-7 [$15.00 $75.00] | $0.00 | 12800 / 1000000 | 1%",
			);
		});
	});
});
