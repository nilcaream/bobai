import { describe, expect, test } from "bun:test";
import type { AuthStore, CopilotAuth } from "../src/auth/store";
import { createConfiguredProvider } from "../src/provider/factory";
import type { Provider } from "../src/provider/provider";

describe("provider factory", () => {
	test("rejects unsupported providers clearly", async () => {
		await expect(createConfiguredProvider({ providerId: "not-real" as never, configDir: "/tmp" })).rejects.toThrow(
			/Unsupported provider/,
		);
	});

	test("creates github-copilot provider from auth store entry", async () => {
		const auth: CopilotAuth = { refresh: "refresh", access: "access", expires: 123 };
		const store: AuthStore = {
			version: 1,
			providers: {
				"github-copilot": auth,
			},
		};
		const provider: Provider = {
			id: "github-copilot",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};

		const result = await createConfiguredProvider(
			{ providerId: "github-copilot", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuthStore: () => store,
				authorizeCopilot: async () => {
					throw new Error("should not be called");
				},
				createCopilotProvider: (loadedAuth, configDir) => {
					expect(loadedAuth).toEqual(auth);
					expect(configDir).toBe("/cfg");
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
	});

	test("creates openrouter provider from auth store entry", async () => {
		const store: AuthStore = {
			version: 1,
			providers: {
				openrouter: { apiKey: "or-key" },
			},
		};
		const provider: Provider = {
			id: "openrouter",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};

		const result = await createConfiguredProvider(
			{ providerId: "openrouter", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuthStore: () => store,
				createOpenRouterProvider: (auth, logger) => {
					expect(auth).toEqual({ apiKey: "or-key" });
					expect(logger).toBeUndefined();
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
	});

	test("creates opencode-go provider from auth store entry", async () => {
		const store = {
			version: 1,
			providers: {
				"opencode-go": { apiKey: "go-key" },
			},
		} as AuthStore;
		const provider: Provider = {
			id: "opencode-go",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};

		const result = await createConfiguredProvider(
			{ providerId: "opencode-go", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuthStore: () => store,
				createOpenCodeGoProvider: (auth) => {
					expect(auth).toEqual({ apiKey: "go-key" });
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
	});

	test("creates opencode-zen provider from auth store entry", async () => {
		const store = {
			version: 1,
			providers: {
				"opencode-zen": { apiKey: "zen-key" },
			},
		} as AuthStore;
		const provider: Provider = {
			id: "opencode-zen",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};

		const result = await createConfiguredProvider(
			{ providerId: "opencode-zen", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuthStore: () => store,
				createOpenCodeZenProvider: (auth) => {
					expect(auth).toEqual({ apiKey: "zen-key" });
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
	});

	test("creates amazon-bedrock provider from auth store entry", async () => {
		const store = {
			version: 1,
			providers: {
				"amazon-bedrock": { apiKey: "bedrock-key", region: "us-east-1" },
			},
		} as AuthStore;
		const provider: Provider = {
			id: "amazon-bedrock",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};

		const result = await createConfiguredProvider(
			{ providerId: "amazon-bedrock", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuthStore: () => store,
				createAmazonBedrockProvider: (auth) => {
					expect(auth).toEqual({ apiKey: "bedrock-key", region: "us-east-1" });
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
	});
});
