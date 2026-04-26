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

function writeCopilotConfig(tmpDir: string) {
	fs.writeFileSync(
		path.join(tmpDir, "copilot-models.json"),
		JSON.stringify([
			{
				id: "claude-haiku-4.5",
				name: "Claude Haiku 4.5",
				contextWindow: 200000,
				maxOutput: 64000,
				premiumRequestMultiplier: 0.33,
				enabled: true,
			},
			{
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				contextWindow: 264000,
				maxOutput: 64000,
				premiumRequestMultiplier: 0,
				enabled: true,
			},
		]),
	);
}

describe("provider model facade", () => {
	test("checks config existence through the provider facade", () => {
		withTempDir((tmpDir) => {
			expect(providerModelsConfigExists("github-copilot", tmpDir)).toBe(false);
			writeCopilotConfig(tmpDir);
			expect(providerModelsConfigExists("github-copilot", tmpDir)).toBe(true);
		});
	});

	test("loads provider model configs through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeCopilotConfig(tmpDir);
			const models = loadProviderModelsConfig("github-copilot", tmpDir);
			expect(models.map((model) => model.id)).toContain("gpt-5-mini");
			expect(getProviderModelConfig("github-copilot", "gpt-5-mini", tmpDir)?.contextWindow).toBe(264000);
		});
	});

	test("formats model display through the provider facade", () => {
		withTempDir((tmpDir) => {
			writeCopilotConfig(tmpDir);
			expect(formatProviderModelDisplay("github-copilot", "gpt-5-mini", 12800, tmpDir)).toBe(
				"github-copilot | gpt-5-mini | 0x | 12800 / 264000 | 5%",
			);
		});
	});

	test("builds the same sorted model list shape used by UI commands", () => {
		withTempDir((tmpDir) => {
			writeCopilotConfig(tmpDir);
			const list = buildSortedProviderModelList("github-copilot", tmpDir);
			expect(list.find((model) => model.id === "gpt-5-mini")).toEqual({
				id: "gpt-5-mini",
				cost: "0x",
				contextWindow: 264000,
			});
		});
	});

	test("uses a configured display label instead of deriving one from copilot pricing semantics", () => {
		withTempDir((tmpDir) => {
			fs.writeFileSync(
				path.join(tmpDir, "copilot-models.json"),
				JSON.stringify([
					{
						id: "gpt-5-mini",
						name: "GPT-5 Mini",
						contextWindow: 264000,
						maxOutput: 64000,
						premiumRequestMultiplier: 0,
						label: "free",
						enabled: true,
					},
				]),
			);

			expect(buildSortedProviderModelList("github-copilot", tmpDir).find((model) => model.id === "gpt-5-mini")).toEqual({
				id: "gpt-5-mini",
				cost: "free",
				contextWindow: 264000,
			});
			expect(formatProviderModelDisplay("github-copilot", "gpt-5-mini", 12800, tmpDir)).toBe(
				"github-copilot | gpt-5-mini | free | 12800 / 264000 | 5%",
			);
		});
	});

	test("loads curated openrouter model metadata through the provider facade", () => {
		const models = loadProviderModelsConfig("openrouter");
		expect(models.find((model) => model.id === "openrouter/free")).toMatchObject({
			contextWindow: expect.any(Number),
			maxOutput: expect.any(Number),
			label: expect.any(String),
		});
		expect(buildSortedProviderModelList("openrouter")).toContainEqual({
			id: "anthropic/claude-haiku-4.5",
			cost: "$0.50 | $5.12",
			contextWindow: 128000,
		});
		expect(formatProviderModelDisplay("openrouter", "anthropic/claude-haiku-4.5", 12800)).toBe(
			"openrouter | anthropic/claude-haiku-4.5 | $0.50 | $5.12 | 12800 / 128000 | 10%",
		);
	});

	test("loads curated opencode-go model metadata through the provider facade", () => {
		const models = loadProviderModelsConfig("opencode-go");
		expect(models.find((model) => model.id === "kimi-k2.6")).toMatchObject({
			contextWindow: 131072,
			maxOutput: expect.any(Number),
			label: "beta",
		});
		expect(buildSortedProviderModelList("opencode-go")).toContainEqual({
			id: "kimi-k2.6",
			cost: "beta",
			contextWindow: 131072,
		});
		expect(formatProviderModelDisplay("opencode-go", "kimi-k2.6", 12800)).toBe(
			"opencode-go | kimi-k2.6 | beta | 12800 / 131072 | 10%",
		);
	});

	test("loads curated opencode-zen model metadata through the provider facade", () => {
		const models = loadProviderModelsConfig("opencode-zen");
		expect(models.find((model) => model.id === "claude-sonnet-4-6")).toMatchObject({
			contextWindow: 200000,
			maxOutput: expect.any(Number),
			label: "beta",
		});
		expect(models.find((model) => model.id === "gpt-5.4")).toMatchObject({
			contextWindow: 272000,
			maxOutput: 64000,
			label: "beta",
		});
		expect(buildSortedProviderModelList("opencode-zen")).toContainEqual({
			id: "claude-sonnet-4-6",
			cost: "beta",
			contextWindow: 200000,
		});
		expect(buildSortedProviderModelList("opencode-zen")).toContainEqual({
			id: "gpt-5.4",
			cost: "beta",
			contextWindow: 272000,
		});
		expect(formatProviderModelDisplay("opencode-zen", "claude-sonnet-4-6", 12800)).toBe(
			"opencode-zen | claude-sonnet-4-6 | beta | 12800 / 200000 | 6%",
		);
		expect(formatProviderModelDisplay("opencode-zen", "gpt-5.4", 12800)).toBe(
			"opencode-zen | gpt-5.4 | beta | 12800 / 272000 | 5%",
		);
	});

	test("throws a clear error for unsupported providers", () => {
		withTempDir((tmpDir) => {
			expect(() => loadProviderModelsConfig("not-real" as never, tmpDir)).toThrow(/Unsupported provider/);
		});
	});
});
