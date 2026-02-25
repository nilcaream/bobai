import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/provider/provider";

describe("ProviderError", () => {
	test("stores status and body", () => {
		const err = new ProviderError(401, "Unauthorized");
		expect(err.status).toBe(401);
		expect(err.body).toBe("Unauthorized");
		expect(err.message).toBe("Provider error (401): Unauthorized");
		expect(err).toBeInstanceOf(Error);
	});
});
