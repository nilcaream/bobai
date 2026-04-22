import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCommand } from "../src/command";
import { buildSortedProviderModelList } from "../src/provider/models";
import { appendMessage, createSession, getSession } from "../src/session/repository";
import { createTestDb } from "./helpers";

describe("provider command", () => {
	test("provider command creates a session on demand and sets backend defaults", () => {
		const db = createTestDb();
		const result = handleCommand(
			db,
			{ command: "provider", args: "1" },
			{
				defaultProviderId: "github-copilot",
				configDir: "/tmp",
				listAuthenticatedProviders: () => [{ index: 1, id: "github-copilot", runtimeSupported: true }],
			},
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const session = getSession(db, result.sessionId as string);
			expect(session?.provider).toBe("github-copilot");
			expect(session?.model).toBe("gpt-5-mini");
			expect(session?.apiFamily).toBe("openai-chat-completions");
		}
		db.close();
	});

	test("provider switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const session = createSession(db, {
			provider: "github-copilot",
			model: "gpt-5-mini",
			apiFamily: "openai-chat-completions",
		});
		appendMessage(db, session.id, "user", "hello");
		const result = handleCommand(
			db,
			{ command: "provider", args: "1", sessionId: session.id },
			{
				defaultProviderId: "github-copilot",
				configDir: "/tmp",
				listAuthenticatedProviders: () => [{ index: 1, id: "github-copilot", runtimeSupported: true }],
			},
		);
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/not yet supported/i) });
		db.close();
	});

	test("cross-family model switch on non-empty session returns not supported error", () => {
		const db = createTestDb();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-provider-command-"));
		try {
			const session = createSession(db, {
				provider: "github-copilot",
				model: "claude-haiku-4.5",
				apiFamily: "anthropic-messages",
			});
			appendMessage(db, session.id, "user", "hello");
			const models = buildSortedProviderModelList("github-copilot", tmpDir);
			const gpt52Index = models.findIndex((model) => model.id === "gpt-5.2") + 1;
			expect(gpt52Index).toBeGreaterThan(0);
			const result = handleCommand(
				db,
				{ command: "model", args: String(gpt52Index), sessionId: session.id },
				{ defaultProviderId: "github-copilot", configDir: tmpDir },
			);
			expect(result).toEqual({ ok: false, error: expect.stringMatching(/API|not yet supported/i) });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			db.close();
		}
	});
});
