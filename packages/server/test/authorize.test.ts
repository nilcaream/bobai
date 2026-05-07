import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AMAZON_BEDROCK_DEFAULT_REGION } from "../src/auth/amazon-bedrock";
import {
	authorizeAmazonBedrock,
	authorizeCopilot,
	authorizeOpenCodeGo,
	authorizeOpenCodeZen,
	authorizeOpenRouter,
	getAuthProvider,
	listSupportedAuthProviders,
} from "../src/auth/authorize";
import { type AuthStore, getAmazonBedrockAuth, listAuthenticatedProviders, setAmazonBedrockAuth } from "../src/auth/store";

const SESSION_TOKEN = "tid=session;proxy-ep=proxy.individual.githubcopilot.com";
const SESSION_EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600;

function createMockFetch() {
	let pollCount = 0;
	return mock(async (url: string | URL | Request, _init?: RequestInit) => {
		const u = url.toString();

		// 1. Device code request
		if (u.includes("/login/device/code")) {
			return new Response(
				JSON.stringify({
					device_code: "dc_test",
					user_code: "TEST-CODE",
					verification_uri: "https://github.com/login/device",
					interval: 0,
					expires_in: 900,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		// 2. Token polling (OAuth access_token)
		if (u.includes("/login/oauth/access_token")) {
			pollCount++;
			if (pollCount === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: "gho_final", token_type: "bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// 3. Token exchange (Copilot session)
		if (u.includes("copilot_internal/v2/token")) {
			return new Response(JSON.stringify({ token: SESSION_TOKEN, expires_at: SESSION_EXPIRES_AT }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not found", { status: 404 });
	}) as typeof fetch;
}

describe("authorizeCopilot", () => {
	const originalFetch = globalThis.fetch;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-auth-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("runs device flow, exchanges, persists auth, and does not write models.json", async () => {
		globalThis.fetch = createMockFetch();

		const result = await authorizeCopilot(tmpDir);

		expect(typeof result).toBe("object");
		expect(result.refresh).toBe("gho_final");
		expect(result.access).toBe(SESSION_TOKEN);
		expect(typeof result.expires).toBe("number");

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.version).toBe(1);
		expect(raw.providers["github-copilot"]?.refresh).toBe("gho_final");
		expect(raw.providers["github-copilot"]?.access).toBe(SESSION_TOKEN);
		expect(typeof raw.providers["github-copilot"]?.expires).toBe("number");
		expect(fs.existsSync(path.join(tmpDir, "models.json"))).toBe(false);

		expect(result).toEqual(raw.providers["github-copilot"]);
	});

	test("saves validated OpenRouter key into auth store", async () => {
		await authorizeOpenRouter(tmpDir, {
			promptSecret: async () => "key-123",
			validateOpenRouterKey: async () => {},
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers.openrouter).toEqual({ apiKey: "key-123" });
	});

	test("does not save OpenRouter key when validation fails", async () => {
		await expect(
			authorizeOpenRouter(tmpDir, {
				promptSecret: async () => "bad-key",
				validateOpenRouterKey: async () => {
					throw new Error("Unauthorized");
				},
			}),
		).rejects.toThrow(/Unauthorized/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});

	test("saves validated OpenCode Go key into auth store", async () => {
		await authorizeOpenCodeGo(tmpDir, {
			promptSecret: async () => "go-key-123",
			validateOpenCodeGoKey: async () => {},
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers["opencode-go"]).toEqual({ apiKey: "go-key-123" });
	});

	test("does not save OpenCode Go key when validation fails", async () => {
		await expect(
			authorizeOpenCodeGo(tmpDir, {
				promptSecret: async () => "bad-go-key",
				validateOpenCodeGoKey: async () => {
					throw new Error("OpenCode Go API key was rejected (401): Unauthorized");
				},
			}),
		).rejects.toThrow(/401|Unauthorized/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});

	test("does not save OpenCode Go key when validation hits quota", async () => {
		await expect(
			authorizeOpenCodeGo(tmpDir, {
				promptSecret: async () => "quota-go-key",
				validateOpenCodeGoKey: async () => {
					throw new Error(
						"OpenCode Go validation request hit a quota or rate limit for model deepseek-v4-flash (429 insufficient_quota): Error from provider (Alibaba): You exceeded your current quota, please check your plan and billing details.",
					);
				},
			}),
		).rejects.toThrow(/429|quota|rate limit/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});

	test("saves validated OpenCode Zen key into auth store", async () => {
		await authorizeOpenCodeZen(tmpDir, {
			promptSecret: async () => "zen-key-123",
			validateOpenCodeZenKey: async () => {},
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers["opencode-zen"]).toEqual({ apiKey: "zen-key-123" });
	});

	test("does not save OpenCode Zen key when validation fails", async () => {
		await expect(
			authorizeOpenCodeZen(tmpDir, {
				promptSecret: async () => "bad-zen-key",
				validateOpenCodeZenKey: async () => {
					throw new Error("Unauthorized");
				},
			}),
		).rejects.toThrow(/Unauthorized/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});
});

describe("amazon-bedrock auth store", () => {
	test("can persist and retrieve amazon-bedrock auth", () => {
		const store: AuthStore = { version: 1, providers: {} };
		const updated = setAmazonBedrockAuth(store, { apiKey: "bedrock-key", region: "us-east-1" });
		expect(getAmazonBedrockAuth(updated)).toEqual({ apiKey: "bedrock-key", region: "us-east-1" });
	});

	test("listAuthenticatedProviders includes amazon-bedrock when auth is set", () => {
		const store = setAmazonBedrockAuth({ version: 1, providers: {} }, { apiKey: "k", region: "us-east-1" });
		expect(listAuthenticatedProviders(store)).toContain("amazon-bedrock");
	});
});

describe("authorizeAmazonBedrock", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-bedrock-auth-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("saves { apiKey, region } into auth.json when validation succeeds", async () => {
		await authorizeAmazonBedrock(tmpDir, {
			promptSecret: async () => "bk-token",
			promptRegion: async () => "eu-west-1",
			fetchBedrockFoundationModels: async () => [],
			refreshBedrockModelsFromFoundation: async () => ({ configPath: "", modelCount: 0, skippedModelCount: 0 }),
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers["amazon-bedrock"]).toEqual({ apiKey: "bk-token", region: "eu-west-1" });
	});

	test("does not write auth.json when validation fails", async () => {
		await expect(
			authorizeAmazonBedrock(tmpDir, {
				promptSecret: async () => "bad-token",
				promptRegion: async () => "us-east-1",
				fetchBedrockFoundationModels: async () => {
					throw new Error("Amazon Bedrock validation failed: 403 Forbidden");
				},
				refreshBedrockModelsFromFoundation: async () => ({ configPath: "", modelCount: 0, skippedModelCount: 0 }),
			}),
		).rejects.toThrow(/403|Forbidden/);

		expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
	});

	test("uses AMAZON_BEDROCK_DEFAULT_REGION when empty string is entered for region", async () => {
		await authorizeAmazonBedrock(tmpDir, {
			promptSecret: async () => "bk-token",
			promptRegion: async () => "",
			fetchBedrockFoundationModels: async () => [],
			refreshBedrockModelsFromFoundation: async () => ({ configPath: "", modelCount: 0, skippedModelCount: 0 }),
		});

		const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")) as AuthStore;
		expect(raw.providers["amazon-bedrock"]?.region).toBe(AMAZON_BEDROCK_DEFAULT_REGION);
	});
});

describe("listSupportedAuthProviders / getAuthProvider", () => {
	test("listSupportedAuthProviders includes an entry with id amazon-bedrock", () => {
		const providers = listSupportedAuthProviders();
		const ids = providers.map((p) => p.id);
		expect(ids).toContain("amazon-bedrock");
	});

	test("getAuthProvider returns a valid entry for amazon-bedrock", () => {
		const entry = getAuthProvider("amazon-bedrock");
		expect(entry).toBeDefined();
		expect(entry?.id).toBe("amazon-bedrock");
		expect(typeof entry?.authorize).toBe("function");
	});

	test("listSupportedAuthProviders returns providers in stable canonical order", () => {
		const ids = listSupportedAuthProviders().map((p) => p.id);
		expect(ids).toEqual(["github-copilot", "openrouter", "opencode-go", "opencode-zen", "amazon-bedrock"]);
	});
});
