import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_ID, getDefaultModelForProvider, isSupportedProvider } from "../src/provider/providers";

describe("provider registry", () => {
	test("exposes github-copilot as the default provider", () => {
		expect(DEFAULT_PROVIDER_ID).toBe("github-copilot");
	});

	test("returns the default model for github-copilot", () => {
		expect(getDefaultModelForProvider("github-copilot")).toBe("gpt-5-mini");
	});

	test("recognizes supported provider ids", () => {
		expect(isSupportedProvider("github-copilot")).toBe(true);
		expect(isSupportedProvider("openrouter")).toBe(false);
		expect(isSupportedProvider("anything-else")).toBe(false);
	});
});
