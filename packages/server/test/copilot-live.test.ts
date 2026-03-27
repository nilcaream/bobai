import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { loadAuth } from "../src/auth/store";
import { createCopilotProvider } from "../src/provider/copilot";
import { AuthError } from "../src/provider/provider";

const configDir = path.join(os.homedir(), ".config", "bobai");
const auth = loadAuth(configDir);

describe.skipIf(!auth)("copilot live", () => {
	test("completes a simple math prompt", async () => {
		const provider = createCopilotProvider(auth as NonNullable<typeof auth>);
		let result = "";
		try {
			for await (const event of provider.stream({
				model: "gpt-4o",
				messages: [{ role: "user", content: "What is 2+7? Return single number." }],
			})) {
				if (event.type === "text") {
					result += event.text;
				}
			}
			expect(result).toContain("9");
		} catch (err) {
			if (err instanceof AuthError && err.permanent) {
				console.warn("Skipping: stored auth token is invalid. Run `bobai auth` to refresh.");
				return;
			}
			throw err;
		}
	}, 30_000);
});
