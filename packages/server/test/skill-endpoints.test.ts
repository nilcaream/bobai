import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";
import type { SkillRegistry } from "../src/skill/skill";

function makeRegistry(skills: Array<{ name: string; description: string; content: string; filePath: string }>): SkillRegistry {
	const map = new Map(skills.map((s) => [s.name, s]));
	return {
		get: (name) => map.get(name),
		list: () => skills,
	};
}

describe("skill HTTP endpoints", () => {
	const registry = makeRegistry([
		{
			name: "tdd",
			description: "Test-driven development",
			content: "# TDD\n\nWrite tests first.",
			filePath: "/skills/tdd/SKILL.md",
		},
		{
			name: "debugging",
			description: "Systematic debugging",
			content: "# Debug\n\nReproduce first.",
			filePath: "/skills/debug/SKILL.md",
		},
	]);

	let server: ReturnType<typeof createServer>;
	let baseUrl: string;

	beforeAll(() => {
		server = createServer({ port: 0, skills: registry });
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	test("GET /bobai/skills returns skill list", async () => {
		const res = await fetch(`${baseUrl}/bobai/skills`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveLength(2);
		expect(data[0]).toHaveProperty("name");
		expect(data[0]).toHaveProperty("description");
		expect(data.map((s: { name: string }) => s.name)).toContain("tdd");
	});

	test("GET /bobai/skills returns empty array when no skills", async () => {
		const emptyServer = createServer({ port: 0, skills: makeRegistry([]) });
		const res = await fetch(`http://localhost:${emptyServer.port}/bobai/skills`);
		const data = await res.json();
		expect(data).toEqual([]);
		emptyServer.stop();
	});

	test("POST /bobai/skill returns skill content", async () => {
		const res = await fetch(`${baseUrl}/bobai/skill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "tdd" }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("tdd");
		expect(data.content).toContain("Write tests first.");
	});

	test("POST /bobai/skill returns 404 for unknown skill", async () => {
		const res = await fetch(`${baseUrl}/bobai/skill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "nonexistent" }),
		});
		expect(res.status).toBe(404);
	});
});
