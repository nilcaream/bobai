import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROVIDER_ID,
	getDefaultModelForProvider,
	isSupportedAuthProvider,
	isSupportedProvider,
	SUPPORTED_AUTH_PROVIDERS,
	SUPPORTED_RUNTIME_PROVIDERS,
} from "../src/provider/providers";

describe("provider registry", () => {
	test("exposes github-copilot as the default runtime provider", () => {
		expect(DEFAULT_PROVIDER_ID).toBe("github-copilot");
	});

	test("lists supported auth providers separately from runtime providers", () => {
		expect(SUPPORTED_AUTH_PROVIDERS).toEqual(["github-copilot", "openrouter"]);
		expect(SUPPORTED_RUNTIME_PROVIDERS).toEqual(["github-copilot"]);
	});

	test("returns the default model for github-copilot", () => {
		expect(getDefaultModelForProvider("github-copilot")).toBe("gpt-5-mini");
	});

	test("recognizes supported runtime provider ids", () => {
		expect(isSupportedProvider("github-copilot")).toBe(true);
		expect(isSupportedProvider("openrouter")).toBe(false);
		expect(isSupportedProvider("anything-else")).toBe(false);
	});

	test("recognizes supported auth provider ids", () => {
		expect(isSupportedAuthProvider("github-copilot")).toBe(true);
		expect(isSupportedAuthProvider("openrouter")).toBe(true);
		expect(isSupportedAuthProvider("anything-else")).toBe(false);
	});
});
