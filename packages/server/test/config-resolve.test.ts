import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/resolve";

describe("resolveConfig", () => {
	test("prefers project provider/model when both are configured", () => {
		const config = resolveConfig(
			{ provider: "github-copilot", model: "claude-sonnet-4" },
			{ provider: "openrouter", model: "openrouter/free" },
		);
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("claude-sonnet-4");
	});

	test("falls back to global provider/model when project does not configure both", () => {
		const config = resolveConfig({ model: "gpt-4o" }, { provider: "github-copilot", model: "gpt-5-mini" });
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-5-mini");
	});

	test("returns null provider/model when neither project nor global config provides both", () => {
		const config = resolveConfig({}, {});
		expect(config.provider).toBeNull();
		expect(config.model).toBeNull();
	});

	test("uses global provider/model when both are configured", () => {
		const config = resolveConfig({}, { provider: "openrouter", model: "openrouter/free" });
		expect(config.provider).toBe("openrouter");
		expect(config.model).toBe("openrouter/free");
	});

	test("maxIterations from global preferences", () => {
		const config = resolveConfig({}, { maxIterations: 50 });
		expect(config.maxIterations).toBe(50);
	});

	test("project maxIterations overrides global", () => {
		const config = resolveConfig({ maxIterations: 30 }, { maxIterations: 50 });
		expect(config.maxIterations).toBe(30);
	});

	test("maxIterations is undefined when not set", () => {
		const config = resolveConfig({}, {});
		expect(config.maxIterations).toBeUndefined();
	});
});
