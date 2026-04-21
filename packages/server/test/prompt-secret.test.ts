import { describe, expect, test } from "bun:test";
import { createSecretPromptController } from "../src/auth/prompt-secret";

describe("secret prompt controller", () => {
	test("collects characters until newline and returns the secret", () => {
		const controller = createSecretPromptController();
		controller.onData("a");
		controller.onData("b");
		controller.onData("c");
		const result = controller.onData("\n");
		expect(result).toBe("abc");
	});

	test("handles DEL backspace", () => {
		const controller = createSecretPromptController();
		controller.onData("a");
		controller.onData("b");
		controller.onData("\u007f");
		const result = controller.onData("\n");
		expect(result).toBe("a");
	});

	test("handles BS backspace", () => {
		const controller = createSecretPromptController();
		controller.onData("a");
		controller.onData("b");
		controller.onData("\b");
		const result = controller.onData("\n");
		expect(result).toBe("a");
	});

	test("treats Ctrl+C as cancellation", () => {
		const controller = createSecretPromptController();
		controller.onData("a");
		expect(() => controller.onData("\u0003")).toThrow(/cancelled/i);
	});
});
