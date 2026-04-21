import { describe, expect, test } from "bun:test";
import type { StoredAuth } from "../src/auth/store";
import { createConfiguredProvider } from "../src/provider/factory";
import type { Provider } from "../src/provider/provider";

describe("provider factory", () => {
	test("rejects unsupported providers clearly", async () => {
		await expect(createConfiguredProvider({ providerId: "not-real" as never, configDir: "/tmp" })).rejects.toThrow(
			/Unsupported provider/,
		);
	});

	test("creates github-copilot provider using stored auth when config exists", async () => {
		const auth: StoredAuth = { refresh: "refresh", access: "access", expires: 123 };
		const provider: Provider = {
			id: "github-copilot",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};
		let authorizeCalled = false;
		let createCopilotProviderCalled = false;

		const result = await createConfiguredProvider(
			{ providerId: "github-copilot", configDir: "/cfg" },
			{
				providerModelsConfigExists: () => true,
				loadAuth: () => auth,
				authorize: async () => {
					authorizeCalled = true;
					return auth;
				},
				createCopilotProvider: (loadedAuth, configDir) => {
					createCopilotProviderCalled = true;
					expect(loadedAuth).toEqual(auth);
					expect(configDir).toBe("/cfg");
					return provider;
				},
			},
		);

		expect(result).toBe(provider);
		expect(authorizeCalled).toBe(false);
		expect(createCopilotProviderCalled).toBe(true);
	});
});
