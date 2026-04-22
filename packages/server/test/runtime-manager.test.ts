import { describe, expect, test } from "bun:test";
import type { Provider } from "../src/provider/provider";
import { createProviderRuntimeManager } from "../src/provider/runtime-manager";

describe("provider runtime manager", () => {
	test("caches github-copilot runtime instance", async () => {
		let calls = 0;
		const fakeProvider: Provider = {
			id: "github-copilot",
			async *stream() {
				yield { type: "finish" as const, reason: "stop" as const };
			},
		};
		const manager = createProviderRuntimeManager(
			{ configDir: "/cfg" },
			{
				createProvider: async () => {
					calls++;
					return fakeProvider;
				},
			},
		);

		const a = await manager.get("github-copilot");
		const b = await manager.get("github-copilot");
		expect(a).toBe(b);
		expect(calls).toBe(1);
	});
});
