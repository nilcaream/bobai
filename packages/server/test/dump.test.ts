import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskAuthHeader, writeDump } from "../src/log/dump";

describe("writeDump", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-dump-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("creates file matching naming pattern", () => {
		writeDump(
			tmpDir,
			{ method: "POST", url: "https://example.com", headers: {}, body: "{}" },
			{ status: 200, statusText: "OK", headers: {}, body: "ok", latencyMs: 42 },
		);

		const files = fs.readdirSync(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^io-\d{8}_\d{9}-[a-z0-9]{4}\.txt$/);
	});

	test("formats HTTP request and response", () => {
		const filename = writeDump(
			tmpDir,
			{
				method: "POST",
				url: "https://api.githubcopilot.com/chat/completions",
				headers: { "Content-Type": "application/json" },
				body: '{"model":"gpt-4o"}',
			},
			{
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream" },
				body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n',
				latencyMs: 450,
			},
		);

		const content = fs.readFileSync(path.join(tmpDir, filename), "utf8");
		expect(content).toContain(">>> POST https://api.githubcopilot.com/chat/completions");
		expect(content).toContain("Content-Type: application/json");
		expect(content).toContain('{"model":"gpt-4o"}');
		expect(content).toContain("<<< 200 OK (450ms)");
		expect(content).toContain("content-type: text/event-stream");
		expect(content).toContain('data: {"choices":[]}');
	});
});

describe("maskAuthHeader", () => {
	test("preserves prefix and last 4 chars of long tokens", () => {
		const masked = maskAuthHeader({ Authorization: "Bearer gho_abcdefghijklmnop" });
		expect(masked.Authorization).toBe("Bearer gho_***mnop");
	});

	test("fully masks short tokens", () => {
		const masked = maskAuthHeader({ Authorization: "Bearer short" });
		expect(masked.Authorization).toBe("Bearer ***");
	});

	test("leaves non-auth headers unchanged", () => {
		const masked = maskAuthHeader({
			"Content-Type": "application/json",
			Authorization: "Bearer gho_abcdefghijkl",
		});
		expect(masked["Content-Type"]).toBe("application/json");
	});
});
