import { describe, expect, test } from "bun:test";
import { DEFAULT_CLIENT_ID } from "../src/auth/device-flow";
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

	test("auth subcommand with defaults", () => {
		const result = parseCLI(["auth"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe(DEFAULT_CLIENT_ID);
	});

	test("auth with --client-id=VALUE", () => {
		const result = parseCLI(["auth", "--client-id=Iv1.custom"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe("Iv1.custom");
	});

	test("auth with --client-id VALUE (space-separated)", () => {
		const result = parseCLI(["auth", "--client-id", "Iv1.custom"]);
		expect(result.command).toBe("auth");
		expect(result.clientId).toBe("Iv1.custom");
	});

	test("auth with --debug", () => {
		const result = parseCLI(["auth", "--debug"]);
		expect(result.command).toBe("auth");
		expect(result.debug).toBe(true);
		expect(result.clientId).toBe(DEFAULT_CLIENT_ID);
	});
});
