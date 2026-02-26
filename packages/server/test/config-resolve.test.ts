import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/resolve";

describe("resolveConfig", () => {
	test("returns defaults when no overrides provided", () => {
		const config = resolveConfig({}, {});
		expect(config.provider).toBe("github-copilot");
		expect(config.model).toBe("gpt-4o");
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

	test("returns empty headers by default", () => {
		const config = resolveConfig({}, {});
		expect(config.headers).toEqual({});
	});

	test("global headers override defaults", () => {
		const config = resolveConfig({}, { headers: { "User-Agent": "Custom/1.0" } });
		expect(config.headers).toEqual({ "User-Agent": "Custom/1.0" });
	});

	test("project headers override global headers", () => {
		const config = resolveConfig(
			{ headers: { "User-Agent": "Project/1.0" } },
			{ headers: { "User-Agent": "Global/1.0", "X-Extra": "val" } },
		);
		expect(config.headers).toEqual({ "User-Agent": "Project/1.0", "X-Extra": "val" });
	});
});
