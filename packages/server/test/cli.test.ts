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

	test("auth subcommand", () => {
		const result = parseCLI(["auth"]);
		expect(result.command).toBe("auth");
	});

	test("auth with --debug", () => {
		const result = parseCLI(["auth", "--debug"]);
		expect(result.command).toBe("auth");
		expect(result.debug).toBe(true);
	});

	test("refresh without --verify defaults to non-verified mode", () => {
		const result = parseCLI(["refresh"]);
		expect(result.command).toBe("refresh");
		expect(result.debug).toBe(false);
		expect(result.verify).toBe(false);
	});

	test("refresh with --verify enables verification mode", () => {
		const result = parseCLI(["refresh", "--verify"]);
		expect(result.command).toBe("refresh");
		expect(result.verify).toBe(true);
	});
});
