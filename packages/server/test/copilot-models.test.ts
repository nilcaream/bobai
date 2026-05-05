import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSortedProviderModelList, formatProviderModelDisplay, loadProviderModelsConfig } from "../src/provider/models";
import { createCopilotModels, writeUnifiedModelsConfig } from "./test-models";

describe("copilot model display semantics via unified catalog", () => {
	test("shows known multiplier labels from unified models.json", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-copilot-models-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{ id: "claude-haiku-4.5", contextWindow: 128000, maxOutput: 64000, premiumRequestMultiplier: 0.33 },
					{ id: "gpt-5-mini", contextWindow: 264000, maxOutput: 64000, premiumRequestMultiplier: 0 },
					{ id: "gpt-5.4", contextWindow: 272000, maxOutput: 64000, premiumRequestMultiplier: 1 },
				]),
			});

			const list = buildSortedProviderModelList("github-copilot", tmpDir);
			expect(list.find((model) => model.id === "claude-haiku-4.5")).toEqual({
				id: "claude-haiku-4.5",
				cost: "0.33x",
				contextWindow: 128000,
			});
			expect(list.find((model) => model.id === "gpt-5-mini")).toEqual({
				id: "gpt-5-mini",
				cost: "0x",
				contextWindow: 264000,
			});
			expect(list.find((model) => model.id === "gpt-5.4")).toEqual({
				id: "gpt-5.4",
				cost: "1x",
				contextWindow: 272000,
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("shows ?x when multiplier is unavailable", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-copilot-models-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([{ id: "gpt-4o", contextWindow: 64000, maxOutput: 4096 }]),
			});

			expect(formatProviderModelDisplay("github-copilot", "gpt-4o", 100, tmpDir)).toBe(
				"github-copilot | gpt-4o | ?x | 100 / 64000 | 0%",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("stores Copilot prices as zero in unified catalog", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-copilot-models-"));
		try {
			writeUnifiedModelsConfig(tmpDir, {
				"github-copilot": createCopilotModels([
					{
						id: "gpt-5.2",
						contextWindow: 264000,
						maxOutput: 64000,
						premiumRequestMultiplier: 1,
						inputPrice: 0,
						outputPrice: 0,
					},
				]),
			});

			expect(loadProviderModelsConfig("github-copilot", tmpDir)).toEqual([
				{
					id: "gpt-5.2",
					name: "gpt-5.2",
					contextWindow: 264000,
					maxOutput: 64000,
					inputPrice: 0,
					outputPrice: 0,
					premiumRequestMultiplier: 1,
				},
			]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
