import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/resolve";

describe("resolveConfig", () => {
	test("returns defaults when no overrides provided", () => {
		const config = resolveConfig({}, {});
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-5-mini");
	});

	test("global preferences override defaults", () => {
		const config = resolveConfig({}, { provider: "zen", model: "zen-1" });
		expect(config.provider).toBe("zen");
		expect(config.model).toBe("zen-1");
	});

	test("project config overrides global preferences", () => {
		const config = resolveConfig({ provider: "github-copilot", model: "claude-sonnet-4" }, { provider: "zen", model: "zen-1" });
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("claude-sonnet-4");
	});

	test("partial project config merges with global", () => {
		const config = resolveConfig({ model: "gpt-4o" }, { provider: "github-copilot", model: "gpt-5-mini" });
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-4o");
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
