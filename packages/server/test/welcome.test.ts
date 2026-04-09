import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

describe("Welcome endpoint", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = createServer({ port: 0, projectRoot: "/test/project" });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop(true);
	});

	test("GET /bobai/welcome returns JSON with markdown field", async () => {
		const res = await fetch(`${baseUrl}/bobai/welcome`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("markdown");
		expect(typeof data.markdown).toBe("string");
	});

	test("welcome markdown contains substituted directory", async () => {
		const res = await fetch(`${baseUrl}/bobai/welcome`);
		const data = await res.json();
		expect(data.markdown).toContain("/test/project");
		expect(data.markdown).not.toContain("__directory__");
	});

	test("welcome markdown contains revision placeholder substituted", async () => {
		const res = await fetch(`${baseUrl}/bobai/welcome`);
		const data = await res.json();
		// In test env, BOBAI_BUILD_REV is not set, so falls back to "dev"
		expect(data.markdown).toContain("dev");
		expect(data.markdown).not.toContain("__revision__");
	});

	test("welcome markdown does not contain raw template variables", async () => {
		const res = await fetch(`${baseUrl}/bobai/welcome`);
		const data = await res.json();
		expect(data.markdown).not.toContain("__date__");
	});

	test("welcome markdown contains the banner", async () => {
		const res = await fetch(`${baseUrl}/bobai/welcome`);
		const data = await res.json();
		expect(data.markdown).toContain("▄▄▄▄");
	});
});
