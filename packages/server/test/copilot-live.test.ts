import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { loadToken } from "../src/auth/store";
import { createCopilotProvider } from "../src/provider/copilot";

const configDir = path.join(os.homedir(), ".config", "bobai");
const token = loadToken(configDir);

describe.skipIf(!token)("copilot live", () => {
	test("completes a simple math prompt", async () => {
		const provider = createCopilotProvider(token!);
		let result = "";
		for await (const chunk of provider.stream({
			model: "gpt-4o",
			messages: [{ role: "user", content: "What is 2+7? Return single number." }],
		})) {
			result += chunk;
		}
		expect(result).toContain("9");
	}, 30_000);
});
