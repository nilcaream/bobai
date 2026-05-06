import { describe, expect, test } from "bun:test";
import { listSupportedAuthProviders } from "../src/auth/authorize";

describe("auth provider registry", () => {
	test("lists auth providers with authorize handlers", () => {
		expect(listSupportedAuthProviders().map((provider) => provider.id)).toEqual([
			"github-copilot",
			"openrouter",
			"opencode-go",
			"opencode-zen",
			"amazon-bedrock",
		]);
	});
});
