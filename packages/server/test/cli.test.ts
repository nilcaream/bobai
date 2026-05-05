import { describe, expect, test } from "bun:test";
import { parseCLI } from "../src/cli";

describe("parseCLI", () => {
	test("no arguments returns serve command", () => {
		const result = parseCLI([]);
		expect(result.command).toBe("serve");
		expect(result.debug).toBe(false);
	});

	test("--debug sets debug flag on serve", () => {
		const result = parseCLI(["--debug"]);
		expect(result.command).toBe("serve");
		expect(result.debug).toBe(true);
	});

	test("auth subcommand without provider", () => {
		const result = parseCLI(["auth"]);
		expect(result.command).toBe("auth");
		expect(result.provider).toBeUndefined();
	});

	test("auth github-copilot", () => {
		const result = parseCLI(["auth", "github-copilot"]);
		expect(result.command).toBe("auth");
		expect(result.provider).toBe("github-copilot");
	});

	test("auth openrouter", () => {
		const result = parseCLI(["auth", "openrouter"]);
		expect(result.command).toBe("auth");
		expect(result.provider).toBe("openrouter");
	});

	test("auth with --debug", () => {
		const result = parseCLI(["auth", "openrouter", "--debug"]);
		expect(result.command).toBe("auth");
		expect(result.provider).toBe("openrouter");
		expect(result.debug).toBe(true);
	});

	test("refresh returns refresh command without verify mode", () => {
		const result = parseCLI(["refresh"]);
		expect(result.command).toBe("refresh");
		expect(result.debug).toBe(false);
	});

	test("refresh rejects removed --verify flag", () => {
		expect(() => parseCLI(["refresh", "--verify"])).toThrow(/--verify has been removed/);
	});
});
