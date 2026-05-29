import { describe, expect, test } from "bun:test";
import { formatConfig } from "../src/config/display";

describe("formatConfig", () => {
	test("formats project config as key = value lines, skipping id", () => {
		const config = {
			id: "abc-123",
			debug: true,
			port: 20002,
			provider: "github-copilot",
			model: "claude-sonnet-4-5",
			maxIterations: 50,
		};

		const result = formatConfig(config, "project");

		expect(result).toContain("debug = true");
		expect(result).toContain("port = 20002");
		expect(result).toContain("provider = github-copilot");
		expect(result).toContain("model = claude-sonnet-4-5");
		expect(result).toContain("maxIterations = 50");
		expect(result).not.toContain("id =");
	});

	test("formats global config as key = value lines", () => {
		const config = {
			debug: false,
			port: 0,
			provider: "openrouter",
		};

		const result = formatConfig(config, "global");

		expect(result).toContain("debug = false");
		expect(result).toContain("port = 0");
		expect(result).toContain("provider = openrouter");
	});

	test("shows (not set) for undefined fields", () => {
		const config: Record<string, unknown> = {};

		const result = formatConfig(config, "project");

		expect(result).toContain("debug = (not set)");
		expect(result).toContain("port = (not set)");
		expect(result).toContain("provider = (not set)");
		expect(result).toContain("model = (not set)");
		expect(result).toContain("maxIterations = (not set)");
	});

	test("each field appears on its own line", () => {
		const config = { debug: true, port: 3000 };

		const result = formatConfig(config, "project");
		const lines = result.split("\n").filter((l) => l.length > 0);

		expect(lines).toHaveLength(5); // 5 fields total for project
		expect(lines[0]).toBe("debug = true");
		expect(lines[1]).toBe("port = 3000");
	});

	test("effective scope shows all fields", () => {
		const config = { debug: true, maxIterations: 100 };

		const result = formatConfig(config, "effective");

		expect(result).toContain("debug = true");
		expect(result).toContain("maxIterations = 100");
	});
});
